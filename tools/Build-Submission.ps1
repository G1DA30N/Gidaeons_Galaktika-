$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $root "dist-submission"
$extensionDir = Join-Path $distRoot "firefox-extension"
$chromiumExtensionDir = Join-Path $distRoot "chromium-extension"
$helperDir = Join-Path $distRoot "helper-installer"
$sourceDir = Join-Path $distRoot "source-code"
$packageDir = Join-Path $distRoot "packages"

function Assert-InRoot {
  param([string]$Path)
  $resolvedRoot = [System.IO.Path]::GetFullPath($root)
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside workspace: $resolvedPath"
  }
}

function Copy-RequiredItem {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Missing required file or directory: $Source"
  }
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function New-ZipWithPortablePaths {
  param(
    [string]$SourceDirectory,
    [string]$DestinationZip
  )

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  if (Test-Path -LiteralPath $DestinationZip) {
    Remove-Item -LiteralPath $DestinationZip -Force
  }

  $resolvedSource = [System.IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\', '/')
  $zip = [System.IO.Compression.ZipFile]::Open($DestinationZip, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $resolvedSource -Recurse -File | Sort-Object FullName | ForEach-Object {
      $resolvedFile = [System.IO.Path]::GetFullPath($_.FullName)
      $relative = $resolvedFile.Substring($resolvedSource.Length).TrimStart('\', '/')
      $entryName = $relative -replace '\\', '/'
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $resolvedFile,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $zip.Dispose()
  }
}

Assert-InRoot $distRoot
if (Test-Path -LiteralPath $distRoot) {
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $extensionDir, $chromiumExtensionDir, $helperDir, $sourceDir, $packageDir | Out-Null

$extensionItems = @(
  "src",
  "popup"
)

foreach ($targetDir in @($extensionDir, $chromiumExtensionDir)) {
  foreach ($item in $extensionItems) {
    Copy-RequiredItem -Source (Join-Path $root $item) -Destination (Join-Path $targetDir $item)
  }
}

Copy-RequiredItem -Source (Join-Path $root "manifest.json") -Destination (Join-Path $extensionDir "manifest.json")
Copy-RequiredItem -Source (Join-Path $root "manifest.chromium.json") -Destination (Join-Path $chromiumExtensionDir "manifest.json")
Remove-Item -LiteralPath (Join-Path $extensionDir "src\background-chromium.js") -Force

$assetItems = @(
  "assets\galaktika-16.png",
  "assets\galaktika-32.png",
  "assets\galaktika-48.png",
  "assets\galaktika-96.png",
  "assets\galaktika-128.png"
)

foreach ($item in $assetItems) {
  foreach ($targetDir in @($extensionDir, $chromiumExtensionDir)) {
    Copy-RequiredItem -Source (Join-Path $root $item) -Destination (Join-Path $targetDir $item)
  }
}

$helperItems = @(
  "Install-Galaktika-Helper.cmd",
  "Update-Galaktika-Dependencies.cmd",
  "Start-Galaktika.cmd",
  "Setup-Galaktika.cmd",
  "tools\Install-Galaktika-Helper.ps1",
  "tools\Update-Galaktika-Dependencies.ps1",
  "native\README.md",
  "native\install-native-host.cmd",
  "native\install-native-host.ps1",
  "native\NativeHostLauncher.cs",
  "native\check_native_host.py",
  "native\check_po_provider.py",
  "native\native_host.py",
  "native\native_host_launcher.cmd",
  "native\server.py",
  "native\uninstall-native-host.cmd"
)

foreach ($item in $helperItems) {
  Copy-RequiredItem -Source (Join-Path $root $item) -Destination (Join-Path $helperDir $item)
}

Copy-RequiredItem -Source (Join-Path $root "SUBMISSION_NOTES.md") -Destination (Join-Path $distRoot "SUBMISSION_NOTES.md")
Copy-RequiredItem -Source (Join-Path $root "PRIVACY.md") -Destination (Join-Path $distRoot "PRIVACY.md")
Copy-RequiredItem -Source (Join-Path $root "REVIEWER_BUILD_README.md") -Destination (Join-Path $distRoot "REVIEWER_BUILD_README.md")

$manifest = Get-Content -LiteralPath (Join-Path $extensionDir "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$extensionZip = Join-Path $packageDir "gidaeons-galaktika-firefox-$version.zip"
$chromiumExtensionZip = Join-Path $packageDir "gidaeons-galaktika-chromium-$version.zip"
$helperZip = Join-Path $packageDir "gidaeons-galaktika-helper-$version.zip"
$sourceZip = Join-Path $packageDir "gidaeons-galaktika-source-$version.zip"

$sourceItems = @(
  "manifest.json",
  "manifest.chromium.json",
  "src",
  "popup",
  "assets\galaktika-16.png",
  "assets\galaktika-32.png",
  "assets\galaktika-48.png",
  "assets\galaktika-96.png",
  "assets\galaktika-128.png",
  "native\README.md",
  "native\install-native-host.cmd",
  "native\install-native-host.ps1",
  "native\NativeHostLauncher.cs",
  "native\check_native_host.py",
  "native\check_po_provider.py",
  "native\native_host.py",
  "native\native_host_launcher.cmd",
  "native\server.py",
  "native\uninstall-native-host.cmd",
  "Start-Galaktika.cmd",
  "Setup-Galaktika.cmd",
  "Install-Galaktika-Helper.cmd",
  "Update-Galaktika-Dependencies.cmd",
  "Release-Galaktika.cmd",
  "Build-Submission.cmd",
  "tools\Build-Submission.ps1",
  "tools\Install-Galaktika-Helper.ps1",
  "tools\Update-Galaktika-Dependencies.ps1",
  "tools\Release-Galaktika.ps1",
  "tests",
  "README.md",
  "REVIEWER_BUILD_README.md",
  "SUBMISSION_NOTES.md",
  "PRIVACY.md",
  ".web-ext-ignore"
)

foreach ($item in $sourceItems) {
  Copy-RequiredItem -Source (Join-Path $root $item) -Destination (Join-Path $sourceDir $item)
}

New-ZipWithPortablePaths -SourceDirectory $extensionDir -DestinationZip $extensionZip
New-ZipWithPortablePaths -SourceDirectory $chromiumExtensionDir -DestinationZip $chromiumExtensionZip
New-ZipWithPortablePaths -SourceDirectory $helperDir -DestinationZip $helperZip
New-ZipWithPortablePaths -SourceDirectory $sourceDir -DestinationZip $sourceZip

Write-Host "Built clean submission package:"
Write-Host "  $extensionZip"
Write-Host ""
Write-Host "Built Chromium MV3 extension package:"
Write-Host "  $chromiumExtensionZip"
Write-Host ""
Write-Host "Built separate helper package:"
Write-Host "  $helperZip"
Write-Host ""
Write-Host "Built source code package:"
Write-Host "  $sourceZip"
Write-Host ""
Write-Host "AMO upload file:"
Write-Host "  $extensionZip"
Write-Host ""
Write-Host "AMO source code file:"
Write-Host "  $sourceZip"
