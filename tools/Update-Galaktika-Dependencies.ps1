param(
  [switch]$SkipDenoDependencies,
  [switch]$SkipProviderCheck
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nativeDir = Join-Path $root "native"
$venvDir = Join-Path $nativeDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$providerDir = Join-Path $nativeDir ".bgutil-provider\server"
$providerCheck = Join-Path $nativeDir "check_po_provider.py"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)."
  }
}

function Find-Deno {
  $dedicated = "C:\ytdl\deno.exe"
  if (Test-Path -LiteralPath $dedicated -PathType Leaf) { return $dedicated }
  $command = Get-Command deno.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Normalize-NodriverEncoding {
  # nodriver 0.50.3 contains a generated Windows-1252 source comment that Python
  # 3.14 rejects. Keep the same compatibility repair used by the installer.
  $nodriverDir = Join-Path $venvDir "Lib\site-packages\nodriver"
  if (-not (Test-Path -LiteralPath $nodriverDir -PathType Container)) { return }
  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  Get-ChildItem -LiteralPath $nodriverDir -Filter *.py -Recurse | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    try {
      [void]$strictUtf8.GetString($bytes)
    } catch [System.Text.DecoderFallbackException] {
      $text = [System.Text.Encoding]::GetEncoding(1252).GetString($bytes)
      [System.IO.File]::WriteAllText($_.FullName, $text, $utf8NoBom)
      Write-Host "Normalized dependency source encoding: $($_.Name)"
    }
  }
}

Write-Host ""
Write-Host "=== Galaktika dependency updater ===" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
  throw "The Galaktika Python environment is not installed. Run Install-Galaktika-Helper.cmd first."
}

Write-Host "Checking the isolated Python environment..."
Invoke-Checked $venvPython @("--version") "The Galaktika Python environment is unusable"

Write-Host "Updating pip tooling..." -ForegroundColor Yellow
Invoke-Checked $venvPython @(
  "-m", "pip", "install", "--disable-pip-version-check", "--upgrade",
  "pip", "setuptools", "wheel"
) "Could not update Python packaging tools"

# This abandoned plugin force-closes Chromium-family browsers through Windows
# Restart Manager. Keep it out of the helper environment.
Write-Host "Removing the unsafe cookie-unlocking plugin if present..."
Invoke-Checked $venvPython @(
  "-m", "pip", "uninstall", "--yes", "yt-dlp-ChromeCookieUnlock"
) "Could not remove yt-dlp-ChromeCookieUnlock"

Write-Host "Updating yt-dlp and PO-token dependencies..." -ForegroundColor Yellow
Invoke-Checked $venvPython @(
  "-m", "pip", "install", "--disable-pip-version-check", "--upgrade",
  "--upgrade-strategy", "eager",
  "yt-dlp", "yt-dlp-getpot-wpc", "bgutil-ytdlp-pot-provider"
) "Could not update the Galaktika yt-dlp runtime"

Normalize-NodriverEncoding

Write-Host "Checking Python dependency consistency..."
Invoke-Checked $venvPython @("-m", "pip", "check") "The updated Python environment has dependency conflicts"

$deno = Find-Deno
if (-not $SkipDenoDependencies) {
  if (-not $deno) {
    throw "Deno 2 or newer was not found. Run Setup-Galaktika.cmd or use -SkipDenoDependencies."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $providerDir "deno.json") -PathType Leaf)) {
    throw "The bundled bgutil provider is missing. Run Install-Galaktika-Helper.cmd first."
  }
  Write-Host "Refreshing bgutil Deno dependencies..." -ForegroundColor Yellow
  Push-Location $providerDir
  try {
    Invoke-Checked $deno @("outdated", "--update") "Could not update compatible bgutil dependency versions"
    Invoke-Checked $deno @("install", "--allow-scripts=npm:canvas") "Could not update bgutil Deno dependencies"
  } finally {
    Pop-Location
  }
}

if (-not $SkipProviderCheck) {
  if (-not $deno) {
    throw "Deno is required for the PO-token provider check. Use -SkipProviderCheck to skip it."
  }
  Write-Host "Warming and validating the bgutil PO-token provider..." -ForegroundColor Yellow
  Invoke-Checked $venvPython @($providerCheck, $deno) "The bgutil PO-token provider check failed"
}

Write-Host ""
Write-Host "Installed versions:" -ForegroundColor Green
Invoke-Checked $venvPython @("-m", "yt_dlp", "--version") "Could not read the yt-dlp version"
Invoke-Checked $venvPython @(
  "-m", "pip", "show", "yt-dlp-getpot-wpc", "bgutil-ytdlp-pot-provider"
) "Could not read provider package versions"
if ($deno) {
  Invoke-Checked $deno @("--version") "Could not read the Deno version"
}

Write-Host ""
Write-Host "Dependency update complete." -ForegroundColor Green
Write-Host "Reload the extension and refresh open YouTube tabs before testing downloads."
