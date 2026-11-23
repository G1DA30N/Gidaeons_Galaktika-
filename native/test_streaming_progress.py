from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import unittest
from array import array
from pathlib import Path
from unittest.mock import patch

NATIVE_DIR = Path(__file__).resolve().parent
if str(NATIVE_DIR) not in sys.path:
  sys.path.insert(0, str(NATIVE_DIR))

import native_host
import server


class StreamingProgressTests(unittest.TestCase):
  def test_video_title_abbreviation_matches_filename_script(self) -> None:
    self.assertEqual(server.abbreviate_video_title("My cool VIDEO 2025 remix"), "MCV2025R")
    self.assertEqual(server.abbreviate_video_title("Beyoncé déjà-vu 12"), "BDV12")
    self.assertEqual(server.abbreviate_video_title("808"), "808")

  def test_printed_video_title_reads_tagged_yt_dlp_output(self) -> None:
    output = 'GALAKTIKA-TITLE:"My Video 2025"\n"C:/temp/source.webm"'
    self.assertEqual(server.printed_video_title(output, "GALAKTIKA-TITLE:"), "My Video 2025")

  def test_game_ffmpeg_profile_matches_tiny_video_script(self) -> None:
    timestamps = {"v:0": 1.25, "a:0": 1.0}
    with patch.object(server, "first_packet_timestamp", side_effect=lambda _path, stream: timestamps[stream]):
      command = server.game_ffmpeg_command(Path("source.mp4"), Path("game.mp4"))

    command_text = " ".join(command)
    self.assertIn("fps=fps=12:round=near", command_text)
    self.assertIn("scale=-2:160:flags=area", command_text)
    self.assertIn("tpad=start_mode=add:start_duration=0.250000:color=black", command_text)
    self.assertIn("aresample=48000:async=1:first_pts=0", command_text)
    self.assertIn("libx264", command)
    self.assertIn("slow", command)
    self.assertIn("38", command)
    self.assertIn("64k", command)
    self.assertIn("+faststart", command)

  def test_game_ffmpeg_profile_supports_video_without_audio(self) -> None:
    with patch.object(server, "first_packet_timestamp", side_effect=[0.0, None]):
      command = server.game_ffmpeg_command(Path("source.mp4"), Path("game.mp4"))

    self.assertIn("-an", command)
    self.assertNotIn("-c:a", command)

  def test_unity_aac_ffmpeg_profile_is_48khz_stereo_aac(self) -> None:
    with (
      patch.object(server, "first_packet_timestamp", return_value=0.0),
      patch.object(server, "probe_audio_bitrate", return_value=137000),
    ):
      command = server.unity_aac_ffmpeg_command(Path("source.webm"), Path("unity.m4a"))

    command_text = " ".join(command)
    self.assertIn("aresample=48000:async=1:first_pts=0", command_text)
    self.assertIn("-c:a aac", command_text)
    self.assertIn("-b:a 137000", command_text)
    self.assertIn("-ac 2", command_text)
    self.assertIn("-ar 48000", command_text)
    self.assertIn("-vn", command)
    self.assertIn("+faststart", command)

  def test_unity_aac_rejects_media_without_audio(self) -> None:
    with patch.object(server, "first_packet_timestamp", return_value=None):
      with self.assertRaisesRegex(ValueError, "audio stream"):
        server.unity_aac_ffmpeg_command(Path("source.mp4"), Path("unity.m4a"))

  def test_source_audio_bitrate_prefers_stream_metadata(self) -> None:
    payload = json.dumps({"streams": [{"bit_rate": "129500"}], "format": {"bit_rate": "131000"}})
    with patch.object(server, "run_text", return_value=payload):
      self.assertEqual(server.probe_audio_bitrate(Path("source.webm")), 129500)

  def test_native_host_dispatches_game_download(self) -> None:
    params = {"url": "https://www.youtube.com/watch?v=test", "outputPath": "game.mp4"}
    expected = {"ok": True, "filename": "game.mp4"}
    progress_callback = object()
    with (
      patch.object(native_host.service, "normalize_youtube_watch_url", return_value=params["url"]),
      patch.object(native_host.service, "download_game_video", return_value=expected) as download_game,
    ):
      result = native_host.dispatch("download-game", params, progress_callback=progress_callback)

    self.assertEqual(result, expected)
    download_game.assert_called_once_with(
      params["url"], params["outputPath"], progress_callback=progress_callback
    )

  def test_native_host_stages_march_downloads(self) -> None:
    params = {
      "url": "https://www.youtube.com/watch?v=test",
      "outputPath": "",
      "march": "true",
    }
    with (
      patch.object(native_host.service, "normalize_youtube_watch_url", return_value=params["url"]),
      patch.object(native_host.service, "download_best_mp4", return_value={"ok": True}) as download_mp4,
    ):
      native_host.dispatch("download-mp4", params)

    download_mp4.assert_called_once_with(params["url"], "", staging=True)

  def test_native_host_dispatches_request_cancellation(self) -> None:
    with patch.object(native_host.service, "cancel_request", return_value=True) as cancel_request:
      result = native_host.dispatch("cancel-request", {"targetRequestId": "march-request"})

    self.assertEqual(result, {"ok": True, "cancelled": True})
    cancel_request.assert_called_once_with("march-request")

  def test_march_cleanup_only_removes_files_inside_download_directory(self) -> None:
    with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside_directory:
      download_dir = Path(directory)
      completed = download_dir / "completed.mp4"
      completed.write_bytes(b"completed")
      outside = Path(outside_directory) / "keep.mp4"
      outside.write_bytes(b"keep")
      with patch.object(server, "get_download_dir", return_value=download_dir):
        result = server.cleanup_march_files([str(completed), str(outside)])

      self.assertEqual(result["removed"], 1)
      self.assertFalse(completed.exists())
      self.assertTrue(outside.exists())

  def test_native_host_dispatches_unity_aac_download(self) -> None:
    params = {"url": "https://www.youtube.com/watch?v=test", "outputPath": "unity.m4a"}
    expected = {"ok": True, "filename": "unity.m4a"}
    progress_callback = object()
    with (
      patch.object(native_host.service, "normalize_youtube_watch_url", return_value=params["url"]),
      patch.object(native_host.service, "download_unity_aac", return_value=expected) as download_aac,
    ):
      result = native_host.dispatch("download-aac", params, progress_callback=progress_callback)

    self.assertEqual(result, expected)
    download_aac.assert_called_once_with(
      params["url"], params["outputPath"], progress_callback=progress_callback
    )

  def test_native_host_sends_game_download_progress(self) -> None:
    messages = []

    def fake_download(_url, _output_path, progress_callback=None):
      progress_callback({"phase": "download", "percent": 42})
      progress_callback({"phase": "convert", "percent": 75})
      return {"ok": True, "filename": "game.mp4"}

    request = {
      "requestId": "game-progress",
      "action": "download-game",
      "params": {"url": "https://www.youtube.com/watch?v=test", "outputPath": "game.mp4"},
      "progress": True,
    }
    with (
      patch.object(native_host.service, "normalize_youtube_watch_url", side_effect=lambda value: value),
      patch.object(native_host.service, "download_game_video", side_effect=fake_download),
      patch.object(native_host, "send_message", side_effect=messages.append),
    ):
      native_host.process_message(request)

    progress_messages = [message for message in messages if message.get("event") == "download-progress"]
    self.assertEqual([message["body"]["percent"] for message in progress_messages], [42, 75])
    self.assertEqual([message["body"]["phase"] for message in progress_messages], ["download", "convert"])
    self.assertEqual(messages[-1]["status"], 200)

  def test_session_cookies_replace_database_access_and_cleanup_on_error(self):
    cookies = [{"domain": ".youtube.com", "name": "test", "value": "synthetic", "path": "/", "secure": True}]
    cookie_path = None
    with self.assertRaisesRegex(RuntimeError, "test failure"):
      with server.session_cookie_file(cookies):
        cookie_path = Path(server.REQUEST_COOKIES.path)
        self.assertIn("synthetic", cookie_path.read_text())
        command = server.yt_dlp_common_args(server.get_yt_dlp_settings())
        self.assertIn("--cookies", command)
        self.assertNotIn("--cookies-from-browser", command)
        raise RuntimeError("test failure")
    self.assertFalse(cookie_path.exists())
    self.assertIsNone(server.REQUEST_COOKIES.path)

  def test_session_cookies_reject_other_domains_and_line_injection(self):
    for cookie in [{"domain": "example.com"}, {"domain": ".youtube.com", "value": "bad\nline"}]:
      with self.assertRaises(ValueError):
        with server.session_cookie_file([cookie]):
          self.fail("invalid cookie accepted")

  def test_empty_session_does_not_fall_back_to_locked_database(self):
    with server.session_cookie_file([]):
      command = server.yt_dlp_common_args(server.get_yt_dlp_settings())
      self.assertIn("--cookies", command)
      self.assertNotIn("--cookies-from-browser", command)

  def test_native_host_emits_keepalives_for_long_requests(self) -> None:
    stop_event = threading.Event()
    message_sent = threading.Event()
    messages = []

    def record_message(message):
      messages.append(message)
      message_sent.set()

    with (
      patch.object(native_host, "KEEPALIVE_INTERVAL_SECONDS", 0.001),
      patch.object(native_host, "send_message", side_effect=record_message),
    ):
      thread = threading.Thread(
        target=native_host.send_request_keepalives,
        args=("request-keepalive", stop_event),
      )
      thread.start()
      message_sent.wait(timeout=0.25)
      stop_event.set()
      thread.join(timeout=1)

    self.assertTrue(messages)
    self.assertTrue(all(message["event"] == "native-keepalive" for message in messages))
    self.assertTrue(all(message["requestId"] == "request-keepalive" for message in messages))

  def test_command_output_tolerates_non_utf8_windows_bytes(self) -> None:
    completed = server.run_capture([
      sys.executable,
      "-c",
      "import sys; sys.stdout.buffer.write(bytes([0x92]))",
    ])

    self.assertEqual(completed.stdout, "\ufffd")

  def test_settings_can_be_saved_without_command_verification(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      config_path = Path(temp_dir) / "config.json"
      with (
        patch.object(server, "CONFIG_PATH", config_path),
        patch.object(
          server,
          "validate_yt_dlp_commands",
          side_effect=AssertionError("command verification ran during Save"),
        ),
      ):
        payload = server.set_yt_dlp_settings({})

      self.assertTrue(config_path.exists())
      self.assertEqual(payload["validation"]["mode"], "unverified")

  def test_waveform_cache_is_bounded_to_thirty_days_and_three_hundred_files(self) -> None:
    self.assertEqual(server.STALE_WAVEFORM_CACHE_SECONDS, 30 * 24 * 60 * 60)
    self.assertEqual(server.MAX_WAVEFORM_CACHE_FILES, 300)

  def test_official_executable_uses_bundled_ejs_by_default(self) -> None:
    settings = server.get_yt_dlp_settings({})
    command = server.yt_dlp_common_args(settings, include_cookies=False)

    self.assertEqual(settings["remoteComponents"], "bundled")
    self.assertNotIn("--remote-components", command)

    settings["remoteComponents"] = "ejs:github"
    override_command = server.yt_dlp_common_args(settings, include_cookies=False)
    self.assertIn("--remote-components", override_command)
    self.assertIn("ejs:github", override_command)

  def test_helper_python_module_is_preferred_for_plugin_discovery(self) -> None:
    with patch.object(server.importlib.util, "find_spec", return_value=object()):
      self.assertEqual(server.yt_dlp_command(), [sys.executable, "-m", "yt_dlp"])

  def test_wpc_provider_uses_detected_thorium_browser(self) -> None:
    settings = server.get_yt_dlp_settings({"poTokenBrowserPath": "auto"})
    with (
      patch.object(server, "yt_dlp_command", return_value=["python", "-m", "yt_dlp"]),
      patch.object(server, "detect_chromium_browser", return_value=r"C:\Thorium\thorium.exe"),
    ):
      command = server.yt_dlp_common_args(settings, include_cookies=False)

    self.assertEqual(command[:3], ["python", "-m", "yt_dlp"])
    self.assertIn(r"youtubepot-wpc:browser_path=C:\Thorium\thorium.exe", command)
    self.assertEqual(command[-1], "--no-playlist")

  def test_explicit_off_disables_wpc_browser_override(self) -> None:
    settings = server.get_yt_dlp_settings({"poTokenBrowserPath": "off"})
    command = server.yt_dlp_common_args(settings, include_cookies=False)
    self.assertFalse(any(str(value).startswith("youtubepot-wpc:") for value in command))

  def test_auto_cookie_source_prefers_live_thorium_profile(self) -> None:
    with patch.object(server, "detect_thorium_profile", return_value=r"C:\Thorium\User Data"):
      self.assertEqual(
        server.resolve_cookies_browser("auto"),
        r"chromium:C:\Thorium\User Data",
      )

  def test_lightweight_health_does_not_launch_yt_dlp(self) -> None:
    with patch.object(native_host.service, "run_text", side_effect=AssertionError("yt-dlp was launched")):
      payload = native_host.health_payload()

    self.assertTrue(payload["ok"])
    self.assertNotIn("ytDlpVersion", payload)

  def test_diagnostics_queries_yt_dlp_version_on_demand(self) -> None:
    with patch.object(native_host.service, "run_text", return_value="test-version") as run_text:
      payload = native_host.health_payload(include_tool_versions=True)

    run_text.assert_called_once()
    self.assertEqual(payload["ytDlpVersion"], "test-version")

  def test_decoder_emits_ordered_partial_peaks_and_completion(self) -> None:
    raw = array("h", [1000, -2000, 3000, -4000] * 2000).tobytes()
    events = []

    peaks, decoded_duration = server.decode_pcm_peak_stream(
      io.BytesIO(raw), 4.0, 40, events.append, 10
    )

    self.assertEqual(len(peaks), 40)
    self.assertEqual(events[0]["startBin"], 0)
    self.assertEqual(events[-1]["completedBins"], 10)
    self.assertTrue(events[-1]["complete"])
    self.assertAlmostEqual(decoded_duration, 4.0)

  def test_youtube_stream_retries_403_before_cookie_fallback(self) -> None:
    success = {2400: {"peaks": [1.0], "duration": 1}}
    attempts = [
      RuntimeError("HTTP Error 403: Forbidden"),
      RuntimeError("HTTP Error 403: Forbidden"),
      success,
    ]

    with (
      patch.object(server, "_stream_youtube_waveforms_attempt", side_effect=attempts) as stream_attempt,
      patch.object(server.time, "sleep") as sleep,
    ):
      result = server.stream_youtube_waveforms("https://www.youtube.com/watch?v=test", [2400])

    self.assertEqual(result, success)
    self.assertEqual(stream_attempt.call_count, 3)
    self.assertTrue(all(call.kwargs["include_cookies"] is False for call in stream_attempt.call_args_list))
    self.assertEqual([call.args[0] for call in sleep.call_args_list], list(server.YOUTUBE_STREAM_RETRY_DELAYS))

  def test_youtube_stream_failure_recommends_po_token_provider_after_fallback(self) -> None:
    failure = RuntimeError("HTTP Error 403: Forbidden")
    attempts = [failure] * (len(server.YOUTUBE_STREAM_RETRY_DELAYS) + 2)

    with (
      patch.object(server, "_stream_youtube_waveforms_attempt", side_effect=attempts) as stream_attempt,
      patch.object(server.time, "sleep"),
    ):
      with self.assertRaisesRegex(RuntimeError, "PO-token provider"):
        server.stream_youtube_waveforms("https://www.youtube.com/watch?v=test", [2400])

    self.assertFalse(stream_attempt.call_args_list[-2].kwargs["include_cookies"])
    self.assertTrue(stream_attempt.call_args_list[-1].kwargs["include_cookies"])

  def test_youtube_bot_check_skips_retries_and_uses_cookie_fallback(self) -> None:
    bot_check = RuntimeError("Sign in to confirm you're not a bot")
    attempts = [bot_check, bot_check]

    with (
      patch.object(server, "_stream_youtube_waveforms_attempt", side_effect=attempts) as stream_attempt,
      patch.object(server.time, "sleep") as sleep,
    ):
      with self.assertRaisesRegex(RuntimeError, "PO-token provider"):
        server.stream_youtube_waveforms("https://www.youtube.com/watch?v=test", [2400])

    self.assertEqual(stream_attempt.call_count, 2)
    self.assertFalse(stream_attempt.call_args_list[0].kwargs["include_cookies"])
    self.assertTrue(stream_attempt.call_args_list[1].kwargs["include_cookies"])
    sleep.assert_not_called()

  def test_native_host_sends_progress_before_final_response(self) -> None:
    messages = []

    def fake_build(_url, _bins, progress_callback=None):
      progress_callback({
        "startBin": 0,
        "peaks": [0.5],
        "completedBins": 1,
        "totalBins": 2,
      })
      return {"peaks": [1.0, 0.5], "duration": 2}

    request = {
      "requestId": "test-1",
      "action": "waveform",
      "params": {"url": "https://www.youtube.com/watch?v=test", "bins": "200"},
      "progress": True,
    }
    with (
      patch.object(native_host.service, "normalize_youtube_watch_url", side_effect=lambda value: value),
      patch.object(native_host.service, "build_waveform", side_effect=fake_build),
      patch.object(native_host, "send_message", side_effect=messages.append),
    ):
      native_host.process_message(request)

    self.assertEqual([message["status"] for message in messages], [206, 200])
    self.assertEqual(messages[0]["event"], "waveform-progress")
    self.assertNotIn("event", messages[1])


if __name__ == "__main__":
  unittest.main()
