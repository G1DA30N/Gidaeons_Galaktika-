param(
  [ValidateSet("Firefox", "Thorium", "Chromium", "Chrome", "Edge", "All")]
  [string[]]$Browsers = @("Firefox", "Thorium"),
  [ValidatePattern("^[a-p]{32}$")]
  [string]$ChromiumExtensionId = "ndafmbdebcekmpocfekdfbidmpocfkko"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nativeDir = Join-Path $root "native"
$installScript = Join-Path $nativeDir "install-native-host.ps1"
$venvDir = Join-Path $nativeDir ".venv"
$bgutilDir = Join-Path $nativeDir ".bgutil-provider"
$bgutilVersion = "2.0.0"

function Find-BasePython {
  $pythonCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python314\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe")
  )
  $python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $python) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $python = $pythonCommand.Source }
  }
  if (-not $python) { throw "Python 3.12 or newer was not found." }
  return $python
}

function Install-HelperDependencies {
  $basePython = Find-BasePython
  $venvPython = Join-Path $venvDir "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "Creating isolated Galaktika Python environment..."
    & $basePython -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { throw "Could not create the Galaktika Python environment." }
  }

  # This plugin force-closes the browser through Windows Restart Manager.
  # Remove previous installs before they can terminate our native connection.
  & $venvPython -m pip uninstall --yes yt-dlp-ChromeCookieUnlock
  if ($LASTEXITCODE -ne 0) { throw "Could not remove the unsafe cookie-unlocking plugin." }
  Write-Host "Installing current yt-dlp and PO-token providers..."
  & $venvPython -m pip install --disable-pip-version-check --upgrade `
    yt-dlp `
    yt-dlp-getpot-wpc `
    bgutil-ytdlp-pot-provider
  if ($LASTEXITCODE -ne 0) { throw "Could not install the Galaktika yt-dlp runtime." }

  # nodriver 0.50.3 ships one generated CDP comment as Windows-1252. Python 3.14
  # correctly rejects that undeclared byte, so normalize affected source files.
  $nodriverDir = Join-Path $venvDir "Lib\site-packages\nodriver"
  if (Test-Path -LiteralPath $nodriverDir) {
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    Get-ChildItem -LiteralPath $nodriverDir -Filter *.py -Recurse | ForEach-Object {
      $sourcePath = $_.FullName
      $sourceName = $_.Name
      $bytes = [System.IO.File]::ReadAllBytes($sourcePath)
      try {
        [void]$strictUtf8.GetString($bytes)
      } catch [System.Text.DecoderFallbackException] {
        $text = [System.Text.Encoding]::GetEncoding(1252).GetString($bytes)
        [System.IO.File]::WriteAllText($sourcePath, $text, $utf8NoBom)
        Write-Host "Normalized dependency source encoding: $sourceName"
      }
    }
  }
}

function Install-BgutilRuntime {
  $denoCandidates = @("C:\ytdl\deno.exe")
  $deno = $denoCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $deno) {
    $denoCommand = Get-Command deno.exe -ErrorAction SilentlyContinue
    if ($denoCommand) { $deno = $denoCommand.Source }
  }
  if (-not $deno) {
    throw "Deno 2 or newer is required for the bgutil PO-token provider. Run Setup-Galaktika.cmd first."
  }

  $serverDir = Join-Path $bgutilDir "server"
  $generator = Join-Path $serverDir "src\generate_once.ts"
  if (-not (Test-Path -LiteralPath $generator)) {
    $downloadDir = Join-Path $nativeDir ".bgutil-download"
    $archivePath = Join-Path $downloadDir "bgutil-$bgutilVersion.zip"
    $expandedDir = Join-Path $downloadDir "expanded"
    foreach ($path in @($downloadDir, $bgutilDir)) {
      $fullPath = [System.IO.Path]::GetFullPath($path)
      $fullNative = [System.IO.Path]::GetFullPath($nativeDir).TrimEnd('\') + '\'
      if (-not $fullPath.StartsWith($fullNative, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace a provider directory outside the native helper: $fullPath"
      }
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    New-Item -ItemType Directory -Force -Path $expandedDir | Out-Null
    Write-Host "Downloading pinned bgutil provider $bgutilVersion..."
    Invoke-WebRequest `
      -Uri "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/$bgutilVersion.zip" `
      -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedDir -Force
    $extracted = Get-ChildItem -LiteralPath $expandedDir -Directory | Select-Object -First 1
    if (-not $extracted) { throw "The bgutil provider archive was empty." }
    Move-Item -LiteralPath $extracted.FullName -Destination $bgutilDir
    Remove-Item -LiteralPath $downloadDir -Recurse -Force
  }

  $canvasModule = Join-Path $serverDir "node_modules\canvas"
  if (-not (Test-Path -LiteralPath $canvasModule)) {
    Write-Host "Installing pinned bgutil Deno dependencies (first install may take several minutes)..."
    Push-Location $serverDir
    try {
      & $deno install --allow-scripts=npm:canvas --frozen
      if ($LASTEXITCODE -ne 0) {
        Write-Host "Retrying the bgutil dependency install after a transient failure..."
        & $deno install --allow-scripts=npm:canvas --frozen
      }
      if ($LASTEXITCODE -ne 0) { throw "Could not install the bgutil Deno dependencies." }
    } finally {
      Pop-Location
    }
  }
}

function Invoke-NativeHostHealth {
  $launcher = Join-Path $nativeDir "native_host_launcher.exe"
  $checkScript = Join-Path $nativeDir "check_native_host.py"
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Native host launcher was not built: $launcher" }
  if (-not (Test-Path -LiteralPath $checkScript)) { throw "Native host check script was not found: $checkScript" }

  $python = Join-Path $venvDir "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $python)) { throw "The Galaktika Python environment was not found." }

  $message = & $python $checkScript $launcher
  if ($LASTEXITCODE -ne 0) { throw "Native host health check process failed." }
  return $message | ConvertFrom-Json
}

Install-HelperDependencies
Install-BgutilRuntime

# Resolve/cache Deno dependencies before yt-dlp's strict 15-second probe.
$providerDeno = "C:\ytdl\deno.exe"
if (-not (Test-Path -LiteralPath $providerDeno)) { $providerDeno = (Get-Command deno.exe -ErrorAction Stop).Source }
& (Join-Path $venvDir "Scripts\python.exe") (Join-Path $nativeDir "check_po_provider.py") $providerDeno
if ($LASTEXITCODE -ne 0) { throw "PO-token provider startup check failed." }

Write-Host "Installing Galaktika native messaging host for: $($Browsers -join ', ')"
& $installScript -Browsers $Browsers -ChromiumExtensionId $ChromiumExtensionId

Write-Host ""
Write-Host "Testing persistent native helper transport..."
$result = Invoke-NativeHostHealth
if (-not $result.ok -or -not $result.body.ok) {
  throw "Native helper health check failed: $($result | ConvertTo-Json -Compress -Depth 5)"
}
Write-Host ($result.body | ConvertTo-Json -Compress -Depth 5)

Write-Host ""
Write-Host "Installed. The selected browser launches the helper only while Galaktika is connected."
Write-Host "Reload the extension from the browser's extension-development page after source changes."
