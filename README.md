# Gidaeon's Galaktika

A Firefox and Chromium/Thorium extension that adds a searchable audio waveform below supported media players. It supports YouTube, CrateDigrs' crate roulette, SampleRoulette, Samplette's YouTube flow, and direct Radiooooo audio.

## Current behavior

- Draws a live waveform and supports click-to-seek.
- Mounts beside YouTube's stable `#below` region instead of inside replaceable metadata, and shows a compact enable control when a long video is excluded.
- Tracks the actual CrateDigrs record from the top page and ignores CrateDigrs' temporary unavailable YouTube iframe.
- `MARCH` repeats a chosen download format through CrateDigrs, SampleRoulette, Samplette, or a YouTube playlist, advances and plays the next item after each completed download, and stops at the end of a playlist or when the user presses `STOP`. While active, it suppresses and cancels waveform work so downloads and advancement get priority.
- While MARCH is active, another format button queues that format once for the current item without changing the repeating default.
- `SKIP` cancels the current MARCH download or conversion, cleans its isolated staging files, advances to the next item, and continues using the original repeating format.
- GAME MP4 and Unity M4A filenames abbreviate the source-video title: numeric-only words remain complete and every other word contributes its uppercase first letter (for example, `My Video 2025` becomes `MV2025`).
- Streams waveform peak chunks through a local browser native-messaging helper so the waveform draws left-to-right while prefetch is still running.
- Streams yt-dlp's selected audio directly into ffmpeg; it does not download a temporary YouTube audio file first.
- Retries transient YouTube media-transfer failures before using the configured cookie fallback, and reports when yt-dlp needs updating.
- Reuses the active Thorium YouTube session and mints fresh per-video tokens through the primary bgutil provider, with WebPoClient as a browser-backed fallback.
- Computes preview and high-resolution waveform caches in the same decode pass.
- Provides `OG`, `WAV`, `MP3`, `AAC`, `MP4`, and `GAME` title-bar buttons with a native Windows save picker. `OG` keeps YouTube's selected source audio codec/container without transcoding.
- Provides separate `Validate` and `Save` actions: Validate checks yt-dlp/ffmpeg and dry-runs the commands, while Save persists structurally safe settings without running command verification.
- Shows long videos as disabled in the browser popup when they exceed the configured exclusion limit; turning the popup switch on creates a per-video override without changing the compatible-video default.
- Can exclude YouTube videos longer than a toggleable `H:MM` limit; exclusion is enabled by default at `1:00` (one hour).
- Starts the helper only while a visible Galaktika panel has an active native-messaging session. Closing the last panel cancels active helper work and exits the process.
- Uses a long-lived extension request port so Chromium MV3 keeps the service worker and native response channel alive during file pickers, token generation, and long downloads.
- Keeps the compact toolbar on one row, with the settings button pinned to the far right.

## Install the helper

Run `Setup-Galaktika.cmd` if Python or ffmpeg is missing. Then double-click:

```text
Install-Galaktika-Helper.cmd
```

This creates an isolated Python environment, installs/updates `yt-dlp`, its PO-token providers, and Chromium cookie support, installs the pinned bgutil generator, compiles and registers the native host for Firefox and Thorium by default, then performs a framed health check. It does not create a Windows startup task, background service, listening port, or localhost server.

To update an existing helper's download runtime later, close active Galaktika downloads and run:

```text
Update-Galaktika-Dependencies.cmd
```

The updater refreshes pip tooling, `yt-dlp`, WebPoClient, the bgutil yt-dlp plugin, and the pinned provider's Deno dependencies; removes the unsafe cookie-unlock plugin if present; checks Python dependency consistency; and validates the PO-token provider.

To register only another Chromium-family browser, run the installer from a terminal with one of these targets:

```text
Install-Galaktika-Helper.cmd -Browsers Thorium
Install-Galaktika-Helper.cmd -Browsers Chromium
Install-Galaktika-Helper.cmd -Browsers Chrome
Install-Galaktika-Helper.cmd -Browsers Edge
Install-Galaktika-Helper.cmd -Browsers All
```

## Load the unsigned add-on

Firefox removes temporary unsigned add-ons whenever Firefox restarts:

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Click **Load Temporary Add-on...**.
4. Select this project's `manifest.json`.
5. Open or refresh a supported page.

After source changes, use **Reload** beside Galaktika on the same debugging page. A signed XPI is required for a permanent regular-Firefox installation.

## Load the Chromium/Thorium MV3 build

1. Run `Build-Submission.cmd`.
2. Open `chrome://extensions` in Chromium/Chrome or `thorium://extensions` in Thorium.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `dist-submission\chromium-extension`.
6. Run `Install-Galaktika-Helper.cmd` once, then open or refresh a supported page.

The development manifest contains a public key that pins the unpacked extension ID to `ndafmbdebcekmpocfekdfbidmpocfkko`. The native host registration uses that ID. If a future Chrome Web Store listing receives a different ID, pass it to the installer with `-ChromiumExtensionId <32-character-id>`.

`Start-Galaktika.cmd` is a convenience shortcut that re-registers the native host and reminds you to reload `manifest.json`; it does not start a resident process.

## Prefetch design

For public YouTube videos, prefetch avoids browser cookies and chooses a small Opus audio stream using:

```text
yt-dlp --no-playlist -f "bestaudio[acodec^=opus]/bestaudio" -S "+size,+br" -o - "<youtube-watch-url>"
```

The helper's isolated yt-dlp installation uses its bundled EJS components, the recommended `mweb` client, and the local bgutil script when YouTube requires a PO token. WebPoClient remains available as a fallback, with a browser path that defaults to `auto` (Thorium first). yt-dlp's stdout is connected directly to ffmpeg, which decodes mono PCM at 2 kHz for peak calculation. During that same pass, compact preview-peak deltas are sent to the browser for progressive drawing; the completed preview and high-resolution waveforms are then cached as JSON. If the public path fails, `auto` reuses the active Thorium cookie profile when available and otherwise uses Firefox. Cookies authenticate the session, while the provider supplies the separate playback attestation. A cache hit does no media work.

Completed waveform JSON is retained for up to 30 days. The cache is also capped at 300 files, so older entries are evicted even if they have not reached the age limit.

This selector is intentionally optimized for transfer size and startup latency, not listening quality: waveform peaks do not benefit from downloading YouTube's highest-bitrate audio.

The download buttons are separate:

- `WAV` requests the best available source audio, then ffmpeg writes 16-bit PCM. WAV is lossless relative to that decoded source, but it cannot restore detail already removed by YouTube's lossy encoding.
- `MP3` produces a broadly compatible compressed audio file.
- `AAC` produces Unity-ready stereo AAC audio in an `.m4a` container at 48 kHz while retaining the downloaded source audio's bitrate (kbps).
- `OG` saves the best available YouTube audio representation in its original downloaded codec/container, normally Opus/WebM or AAC/M4A, without a lossy conversion.
- `MP4` downloads/merges the selected video and audio streams.
- `GAME` creates a tiny game-ready MP4 using the TinyVideo profile: H.264 at 12 fps, 160 px height with an even aspect-derived width, CRF 38, 48 kHz stereo AAC at 64 kbps, normalized stream timing, and fast-start metadata.
- During `AAC` and `GAME` jobs, the top-edge star and trail show the live percentage for the download and conversion phases, while native-helper activity refreshes the request timeout.

A two-minute, 48 kHz stereo 16-bit WAV is about 23 MB before metadata; 30 MB is normal for roughly 2 minutes 38 seconds. That size comes from uncompressed PCM, not from extra source fidelity.

## Files

- `manifest.json` — Firefox Manifest V2 add-on manifest.
- `manifest.chromium.json` — Chromium/Thorium Manifest V3 source manifest.
- `src/browser-compat.js` — shared `browser`/`chrome` API compatibility bootstrap.
- `src/background-chromium.js` — Chromium service-worker entry point.
- `src/content.js` — page UI, waveform rendering, seeking, settings, and downloads.
- `src/cratedigrs-page-bridge.js` — CrateDigrs YouTube-player state and seek bridge.
- `src/background.js` — session-scoped native-messaging bridge shared by both builds.
- `native/native_host.py` — persistent framed native protocol dispatcher.
- `native/server.py` — waveform and download service functions used by the native host.
- `native/NativeHostLauncher.cs` — small stdio broker used by supported browsers on Windows.

To remove the native registration, run `native\uninstall-native-host.cmd`.
