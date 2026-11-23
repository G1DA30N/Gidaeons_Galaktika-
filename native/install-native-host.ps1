param(
  [ValidateSet("Firefox", "Thorium", "Chromium", "Chrome", "Edge", "All")]
  [string[]]$Browsers = @("Firefox", "Thorium"),
  [ValidatePattern("^[a-p]{32}$")]
  [string]$ChromiumExtensionId = "ndafmbdebcekmpocfekdfbidmpocfkko"
)

$ErrorActionPreference = "Stop"

$launcherExe = Join-Path $PSScriptRoot "native_host_launcher.exe"
$launcherCmd = Join-Path $PSScriptRoot "native_host_launcher.cmd"
$launcherSource = Join-Path $PSScriptRoot "NativeHostLauncher.cs"
$hostName = "gidaeons_galaktika_host"

function Get-CSharpCompiler {
  $candidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Get-BrowserDefinition {
  param([string]$Browser)

  switch ($Browser) {
    "Firefox" {
      return @{
        ManifestDir = Join-Path $env:APPDATA "Mozilla\NativeMessagingHosts"
        RegistryKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
        OriginField = "allowed_extensions"
        Origins = @("gidaeons-galaktika@gidae.local")
      }
    }
    "Thorium" { $registry = "HKCU:\Software\Thorium\NativeMessagingHosts\$hostName" }
    "Chromium" { $registry = "HKCU:\Software\Chromium\NativeMessagingHosts\$hostName" }
    "Chrome" { $registry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" }
    "Edge" { $registry = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }
    default { throw "Unsupported browser target: $Browser" }
  }

  return @{
    ManifestDir = Join-Path $env:LOCALAPPDATA "GidaeonsGalaktika\NativeMessagingHosts\$Browser"
    RegistryKey = $registry
    OriginField = "allowed_origins"
    Origins = @("chrome-extension://$ChromiumExtensionId/")
  }
}

$compiler = Get-CSharpCompiler
if ($compiler) {
  Write-Host "Building native messaging launcher:"
  Write-Host $launcherExe
  & $compiler /nologo /target:exe /out:$launcherExe $launcherSource
  if ($LASTEXITCODE -ne 0) { throw "Could not build native messaging launcher." }
}

$launcher = $launcherExe
if (-not (Test-Path -LiteralPath $launcher)) {
  $launcher = $launcherCmd
  Write-Warning "Native launcher executable was not built. Falling back to .cmd launcher, which browsers may not be able to start directly."
}

$targets = if ($Browsers -contains "All") {
  @("Firefox", "Thorium", "Chromium", "Chrome", "Edge")
} else {
  @($Browsers | Select-Object -Unique)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($browser in $targets) {
  $definition = Get-BrowserDefinition $browser
  $hostDir = $definition.ManifestDir
  $hostFile = Join-Path $hostDir "$hostName.json"
  New-Item -ItemType Directory -Force -Path $hostDir | Out-Null

  $manifest = [ordered]@{
    name = $hostName
    description = "Gidaeon's Galaktika native helper launcher"
    path = $launcher
    type = "stdio"
  }
  $manifest[$definition.OriginField] = $definition.Origins
  [System.IO.File]::WriteAllText($hostFile, ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)

  New-Item -Path $definition.RegistryKey -Force | Out-Null
  Set-Item -Path $definition.RegistryKey -Value $hostFile

  Write-Host "Registered $browser native messaging host:"
  Write-Host "  Manifest: $hostFile"
  Write-Host "  Registry: $($definition.RegistryKey)"
}
