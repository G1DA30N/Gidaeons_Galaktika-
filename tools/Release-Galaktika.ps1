$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $root "manifest.json"
$buildScript = Join-Path $root "tools\Build-Submission.ps1"

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

Write-Host "Gidaeon's Galaktika release helper"
Write-Host "Version: $version"
Write-Host ""
Write-Host "Building Firefox, Chromium MV3, source-code, and helper packages..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript

$packageDir = Join-Path $root "dist-submission\packages"
$extensionZip = Join-Path $packageDir "gidaeons-galaktika-firefox-$version.zip"
$chromiumExtensionZip = Join-Path $packageDir "gidaeons-galaktika-chromium-$version.zip"
$sourceZip = Join-Path $packageDir "gidaeons-galaktika-source-$version.zip"
$helperZip = Join-Path $packageDir "gidaeons-galaktika-helper-$version.zip"

Write-Host ""
Write-Host "Upload these to AMO:"
Write-Host "Add-on file:"
Write-Host "  $extensionZip"
Write-Host "Source code file:"
Write-Host "  $sourceZip"
Write-Host ""
Write-Host "Keep/share separately as the local helper package:"
Write-Host "  $helperZip"
Write-Host ""
Write-Host "Chromium/Thorium MV3 package:"
Write-Host "  $chromiumExtensionZip"
Write-Host ""
Write-Host "Reminder: bump manifest.json version before running this when extension code changes."
