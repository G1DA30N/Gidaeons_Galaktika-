# Gidaeon's Galaktika Submission Notes

## Recommended Distribution

Submit this add-on as an unlisted/self-distributed Firefox extension first. This produces a signed XPI for permanent installation in regular Firefox while keeping the project private during testing.

## Reviewer Notes

Gidaeon's Galaktika adds an audio waveform interface to supported music/video pages:

- YouTube watch pages and embeds.
- Samplette pages that expose a YouTube link.
- Radiooooo pages that expose a direct audio file URL.

The extension uses a local native messaging host named `gidaeons_galaktika_host` to communicate with a local helper process. The native helper is installed separately by the user and is not bundled into the Firefox extension package submitted to AMO. Firefox starts it only while a visible Galaktika session is active and closes it when that session ends.

The helper communicates over Firefox's length-prefixed native-messaging stdio transport; it does not run a localhost server. Its installer creates a local Python virtual environment containing yt-dlp, PO-token providers, and Chromium cookie snapshot support. When YouTube requires playback attestation, the primary bgutil script mints a per-video token on demand; a browser-backed WebPoClient provider remains available as fallback. For YouTube waveform prefetching the helper streams yt-dlp output directly into locally installed ffmpeg without a temporary media download and sends partial peak chunks to Firefox while decoding. For Radiooooo downloads it uses the direct audio URL observed on the page. Downloaded files are written only to a user-selected local directory.

The extension does not collect, sell, transmit, or store personal data on a developer-controlled server. Local settings such as enabled state and command preferences are stored with Firefox extension storage or the local helper configuration file on the user's machine.

## Permission Explanations

- `nativeMessaging`: communicates with the separately installed local helper.
- `storage`: saves local extension preferences.
- YouTube host permissions: injects the waveform UI and synchronizes seeking on YouTube pages.
- Samplette host permissions: detects copied/current YouTube URLs for the embedded player flow.
- `app.radiooooo.com`: injects the waveform UI and synchronizes Radiooooo playback.
- `https://radiooooo-track.b-cdn.net/*`: reads Radiooooo audio URLs for waveform/download actions.

## Packaging

Run:

```text
Build-Submission.cmd
```

Upload only the generated extension ZIP from:

```text
dist-submission/packages/
```

Do not upload the helper ZIP to AMO as the Firefox extension. The helper ZIP is for user installation outside Firefox.

The same build also creates `gidaeons-galaktika-chromium-<version>.zip`. That Manifest V3 package is for Thorium/Chromium-family testing or a separate Chrome Web Store submission; it is not the AMO upload.

## Source Code Build Notes

The submitted extension is not transpiled, bundled, concatenated, or minified. The build script copies the raw source files into a clean package directory and creates an AMO-compatible ZIP with forward-slash archive paths.

Build requirements:

- Windows 10 or Windows 11.
- Windows PowerShell 5.1 or newer.
- No Node.js, npm, webpack, Babel, TypeScript, or third-party build dependency is required.

Step-by-step source build instructions are included in:

```text
REVIEWER_BUILD_README.md
```
