# Galaktika native helper

The helper is a cross-browser native-messaging application. Firefox or a supported Chromium-family browser launches it on demand, keeps one framed stdio connection open while a visible Galaktika panel exists, and closes it when the last session ends.

## Requirements

- Windows 10 or 11
- Python 3.12+
- `ffmpeg` and `ffprobe` on `PATH`

From the project root, run:

```text
Install-Galaktika-Helper.cmd
```

The installer creates an isolated `native/.venv`, installs current `yt-dlp`, the bgutil and WebPoClient PO-token providers, and Chromium cookie-unlock support. It also installs the pinned bgutil generation script under `native/.bgutil-provider`, builds `native_host_launcher.exe`, writes browser-specific native-host manifests, registers their current-user lookup keys, and performs a protocol health check. Firefox uses `allowed_extensions`; Thorium, Chromium, Chrome, and Edge use `allowed_origins` with the pinned Chromium extension ID.

There is no scheduled task, Windows service, localhost listener, CORS bridge, or idle background process. The host's lifetime is the browser native connection. Closing Galaktika also cancels active yt-dlp/ffmpeg child processes.

## Waveform prefetch

Prefetch selects a transfer-efficient audio representation, writes it to stdout, and pipes it into ffmpeg. ffmpeg decodes mono 2 kHz PCM while Python calculates all requested peak resolutions in one pass and emits compact preview-peak deltas for left-to-right drawing in the browser. No temporary YouTube media file is created; completed waveform JSON caches are retained for up to 30 days and capped at 300 files.

The bgutil generation script is the primary token provider and runs only when yt-dlp requests a fresh token; it does not create a persistent listener. WebPoClient remains a browser-backed fallback. `auto` prefers Thorium and then Chromium/Chrome for that fallback; Settings can provide an explicit browser executable.

Public media is tried without browser cookies first. On Windows, the default `auto` cookie source reuses the active Thorium profile when present and otherwise uses Firefox. The installed cookie-unlock plugin allows yt-dlp to take a safe database snapshot while Thorium remains open; the provider separately supplies playback attestation tokens.

The settings panel keeps validation and saving separate. `Validate` checks dependencies, argument safety, and yt-dlp dry runs without downloading media; `Save` performs structural safety checks and writes `config.json` without command verification.

Run `uninstall-native-host.cmd` to remove the Firefox, Thorium, Chromium, Chrome, and Edge registrations created by the installer.
