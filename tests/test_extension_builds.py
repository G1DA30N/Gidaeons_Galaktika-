from __future__ import annotations

import base64
import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIREFOX_MANIFEST = ROOT / "manifest.json"
CHROMIUM_MANIFEST = ROOT / "manifest.chromium.json"
EXPECTED_CHROMIUM_ID = "ndafmbdebcekmpocfekdfbidmpocfkko"


def load_manifest(path: Path) -> dict:
  return json.loads(path.read_text(encoding="utf-8"))


def chromium_id_from_key(encoded_key: str) -> str:
  digest = hashlib.sha256(base64.b64decode(encoded_key)).digest()[:16]
  alphabet = "abcdefghijklmnop"
  return "".join(alphabet[nibble] for byte in digest for nibble in (byte >> 4, byte & 15))


def referenced_files(manifest: dict) -> set[str]:
  paths: set[str] = set()
  paths.update(manifest.get("icons", {}).values())

  background = manifest.get("background", {})
  paths.update(background.get("scripts", []))
  if background.get("service_worker"):
    paths.add(background["service_worker"])

  action = manifest.get("action") or manifest.get("browser_action") or {}
  paths.update(action.get("default_icon", {}).values())
  if action.get("default_popup"):
    paths.add(action["default_popup"])

  for content_script in manifest.get("content_scripts", []):
    paths.update(content_script.get("js", []))
    paths.update(content_script.get("css", []))

  resources = manifest.get("web_accessible_resources", [])
  for item in resources:
    if isinstance(item, str):
      paths.add(item)
    else:
      paths.update(resource for resource in item.get("resources", []) if "*" not in resource)
  return paths


class ExtensionBuildTests(unittest.TestCase):
  def setUp(self) -> None:
    self.firefox = load_manifest(FIREFOX_MANIFEST)
    self.chromium = load_manifest(CHROMIUM_MANIFEST)

  def test_parallel_manifests_have_matching_identity(self) -> None:
    self.assertEqual(self.firefox["name"], self.chromium["name"])
    self.assertEqual(self.firefox["version"], self.chromium["version"])
    self.assertEqual(self.firefox["manifest_version"], 2)
    self.assertEqual(self.chromium["manifest_version"], 3)

  def test_chromium_key_pins_expected_native_messaging_origin(self) -> None:
    self.assertEqual(chromium_id_from_key(self.chromium["key"]), EXPECTED_CHROMIUM_ID)

  def test_chromium_uses_service_worker_and_action(self) -> None:
    self.assertEqual(self.chromium["background"]["service_worker"], "src/background-chromium.js")
    self.assertIn("action", self.chromium)
    self.assertNotIn("browser_action", self.chromium)
    self.assertGreaterEqual(int(self.chromium["minimum_chrome_version"]), 105)

  def test_chromium_content_scripts_load_compatibility_first(self) -> None:
    for declaration in self.chromium["content_scripts"]:
      self.assertEqual(declaration["js"][0], "src/browser-compat.js")

  def test_all_manifest_file_references_exist(self) -> None:
    for manifest in (self.firefox, self.chromium):
      for relative_path in referenced_files(manifest):
        self.assertTrue((ROOT / relative_path).is_file(), relative_path)

  def test_cratedigrs_top_page_and_bridge_are_in_both_builds(self) -> None:
    for manifest in (self.firefox, self.chromium):
      matches = {
        match
        for declaration in manifest["content_scripts"]
        for match in declaration.get("matches", [])
      }
      self.assertIn("*://cratedigrs.com/*", matches)
      self.assertIn("*://www.cratedigrs.com/*", matches)
      self.assertIn("src/cratedigrs-page-bridge.js", referenced_files(manifest))

  def test_sampleroulette_top_page_and_bridge_are_in_both_builds(self) -> None:
    for manifest in (self.firefox, self.chromium):
      matches = {
        match
        for declaration in manifest["content_scripts"]
        for match in declaration.get("matches", [])
      }
      self.assertIn("*://sampleroulette.io/*", matches)
      self.assertIn("*://www.sampleroulette.io/*", matches)
      self.assertIn("src/sampleroulette-page-bridge.js", referenced_files(manifest))

  def test_samplette_loads_full_galaktika_and_url_capture_in_both_builds(self) -> None:
    for manifest in (self.firefox, self.chromium):
      matching_declarations = [
        declaration
        for declaration in manifest["content_scripts"]
        if "*://samplette.io/*" in declaration.get("matches", [])
      ]
      self.assertTrue(any("src/content.js" in declaration.get("js", []) for declaration in matching_declarations))
      self.assertTrue(any("src/site-url-bridge.js" in declaration.get("js", []) for declaration in matching_declarations))

  def test_march_uses_one_folder_repeating_format_and_one_off_overrides(self) -> None:
    content = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
    helper = (ROOT / "native" / "server.py").read_text(encoding="utf-8")

    self.assertIn('.textContent = "MARCH"', content)
    self.assertIn("async chooseMarchDirectory()", content)
    self.assertIn("async runMarch(token, previousKey", content)
    self.assertIn("this.marchCurrentOverrides", content)
    self.assertIn("this.marchPendingOverrides", content)
    self.assertIn("advanceMarchTrack()", content)
    self.assertIn('document.querySelector("#samplette-btn")', content)
    self.assertIn("skipPicker: true", content)
    self.assertIn("ysw-march-default", styles)
    self.assertIn("Choose Galaktika MARCH download directory", helper)
    self.assertIn('.textContent = "SKIP"', content)
    self.assertIn("async skipMarchItem()", content)
    self.assertIn('type: "ysw:skip-march-download"', content)
    self.assertIn("this.marchCurrentSavedPaths", content)
    self.assertIn('requestUrl.searchParams.set("march", "true")', content)
    self.assertIn("download_workspace(download_dir, staging)", helper)

  def test_march_supports_youtube_playlists_and_passive_embedded_players(self) -> None:
    content = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    background = (ROOT / "src" / "background.js").read_text(encoding="utf-8")
    styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
    helper = (ROOT / "native" / "server.py").read_text(encoding="utf-8")
    crate_bridge = (ROOT / "src" / "cratedigrs-page-bridge.js").read_text(encoding="utf-8")
    roulette_bridge = (ROOT / "src" / "sampleroulette-page-bridge.js").read_text(encoding="utf-8")

    self.assertIn("function isYoutubePlaylistPage()", content)
    self.assertIn("function isMarchSupportedPage()", content)
    self.assertIn('document.querySelectorAll("ytd-playlist-panel-video-renderer")', content)
    self.assertIn('.ytp-next-button[aria-disabled="false"]', content)
    self.assertIn('return "finished"', content)
    self.assertIn("end of the YouTube playlist", content)
    self.assertIn("if (!isMarchSupportedPage() ||", content)
    self.assertIn("async enterMarchFastMode()", content)
    self.assertIn('type: "ysw:cancel-waveform-work"', content)
    self.assertIn("if (this.marchFastMode) return false", content)
    self.assertIn('message.type === "ysw:cancel-waveform-work"', background)
    self.assertIn('message.type === "ysw:skip-march-download"', background)
    self.assertIn('requestNative("cleanup-march-files"', background)
    self.assertIn('request.action === "waveform"', background)
    self.assertIn(".ysw-march-mode .ysw-canvas", styles)
    for bridge in (crate_bridge, roulette_bridge):
      self.assertIn('message?.event === "infoDelivery"', bridge)
      self.assertIn('event: "listening"', bridge)
      self.assertIn('func: "seekTo"', bridge)

  def test_digging_sites_use_bounded_in_page_slots(self) -> None:
    content = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")

    self.assertIn("function placeExternalPageRoot(root)", content)
    self.assertIn('slot.dataset.yswPlacement = isCrateDigrsPage()', content)
    self.assertIn('? "sampleroulette"', content)
    self.assertIn(': "samplette"', content)
    self.assertIn("--ysw-external-width", content)
    self.assertIn('[data-ysw-placement="cratedigrs"]', styles)
    self.assertIn('[data-ysw-placement="sampleroulette"]', styles)

  def test_youtube_mount_uses_stable_below_anchor_and_exclusion_notice(self) -> None:
    content = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    self.assertIn("function getNativeBelowAnchor()", content)
    self.assertIn("belowAnchor.parentElement.insertBefore(slot, belowAnchor)", content)
    self.assertIn("Enable for this video", content)

  def test_native_requests_use_long_lived_extension_port(self) -> None:
    content = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    background = (ROOT / "src" / "background.js").read_text(encoding="utf-8")

    self.assertIn('browser.runtime.connect({ name: "ysw:native-request" })', content)
    self.assertIn('port.postMessage({ type: "ysw:native-request-keepalive" })', content)
    self.assertIn("browser.runtime.onConnect.addListener", background)
    self.assertIn("clientRequestPorts.add(clientPort)", background)
    self.assertIn('message?.event === "native-keepalive"', background)
    self.assertIn(
      "activeSessions.size === 0 && pendingRequests.size === 0 && clientRequestPorts.size === 0",
      background,
    )
    self.assertIn("clientRequestPorts.delete(clientPort);\n      maybeDisconnectNative();", background)
    session_close = background.split('if (request.action === "session/close")', 1)[1].split("return {", 1)[0]
    self.assertIn("maybeDisconnectNative()", session_close)
    self.assertNotIn("disconnectNative(", session_close)

  def test_game_download_is_wired_through_the_chromium_ui(self) -> None:
    content = (ROOT / "src" / "content.js").read_text(encoding="utf-8")
    background = (ROOT / "src" / "background.js").read_text(encoding="utf-8")
    styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")
    helper = (ROOT / "native" / "server.py").read_text(encoding="utf-8")

    self.assertIn('.textContent = "GAME"', content)
    self.assertIn('this.handleFormatClick("game")', content)
    self.assertIn('galaktika-native://helper/download-game', content)
    self.assertIn('.textContent = "AAC"', content)
    self.assertIn('this.handleFormatClick("aac")', content)
    self.assertIn('galaktika-native://helper/download-aac', content)
    self.assertIn("function abbreviateVideoTitle(value)", content)
    self.assertIn('abbreviateVideoTitle(sanitizeDownloadName(document.title', content)
    self.assertIn('abbreviateVideoTitle(titleResponse.body?.title', content)
    self.assertIn("applyDownloadProgress(progress, label)", content)
    self.assertIn("--ysw-loading-progress", styles)
    self.assertIn('"download-game"', background)
    self.assertIn('"download-aac"', background)
    self.assertIn("refreshPendingTimeout(requestId, pending)", background)
    self.assertIn('message?.event === "download-progress"', background)
    self.assertIn('unique_path(download_dir / f"{title_abbreviation}.mp4")', helper)
    self.assertIn('unique_path(download_dir / f"{title_abbreviation}.m4a")', helper)

  def test_dependency_updater_covers_supported_runtime_and_is_packaged(self) -> None:
    updater = (ROOT / "tools" / "Update-Galaktika-Dependencies.ps1").read_text(encoding="utf-8")
    build_script = (ROOT / "tools" / "Build-Submission.ps1").read_text(encoding="utf-8")

    for dependency in ("yt-dlp", "yt-dlp-getpot-wpc", "bgutil-ytdlp-pot-provider"):
      self.assertIn(f'"{dependency}"', updater)
    self.assertIn('"--upgrade-strategy", "eager"', updater)
    self.assertIn('"-m", "pip", "check"', updater)
    self.assertIn('"outdated", "--update"', updater)
    self.assertIn('"install", "--allow-scripts=npm:canvas"', updater)
    self.assertIn("Update-Galaktika-Dependencies.cmd", build_script)
    self.assertIn("tools\\Update-Galaktika-Dependencies.ps1", build_script)


if __name__ == "__main__":
  unittest.main()
