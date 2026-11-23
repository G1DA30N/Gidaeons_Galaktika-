#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NATIVE_DIR = ROOT / "native"
if str(NATIVE_DIR) not in sys.path:
  sys.path.insert(0, str(NATIVE_DIR))

import server as service

HOST_VERSION = "0.5.9"
WRITE_LOCK = threading.Lock()
KEEPALIVE_INTERVAL_SECONDS = 10.0


def read_message() -> dict | None:
  raw_length = sys.stdin.buffer.read(4)
  if not raw_length:
    return None
  if len(raw_length) != 4:
    raise EOFError("Native message length was incomplete.")
  length = struct.unpack("<I", raw_length)[0]
  data = sys.stdin.buffer.read(length)
  if len(data) != length:
    raise EOFError("Native message payload was incomplete.")
  return json.loads(data.decode("utf-8"))


def send_message(payload: dict) -> None:
  data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
  with WRITE_LOCK:
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def send_request_keepalives(request_id: str, stop_event: threading.Event) -> None:
  while not stop_event.wait(KEEPALIVE_INTERVAL_SECONDS):
    try:
      send_message({
        "requestId": request_id,
        "ok": True,
        "status": 102,
        "statusText": "Processing",
        "event": "native-keepalive",
        "body": {},
        "transport": "native-messaging",
      })
    except (BrokenPipeError, OSError, ValueError):
      return


def query_from_params(params: dict) -> dict[str, list[str]]:
  query = {}
  for key, value in params.items():
    if value is None:
      continue
    if isinstance(value, (dict, list)):
      query[key] = [json.dumps(value, separators=(",", ":"))]
    else:
      query[key] = [str(value)]
  return query


def health_payload(include_tool_versions: bool = False) -> dict:
  payload = {
    "ok": True,
    "service": "gidaeons-galaktika-native-helper",
    "version": HOST_VERSION,
    "helperVersion": service.HELPER_VERSION,
    "transport": "native-messaging",
    "pid": os.getpid(),
    "python": sys.executable,
    "downloadDir": str(service.get_download_dir()),
    "settings": service.get_yt_dlp_settings(),
  }
  if include_tool_versions:
    try:
      payload["ytDlpVersion"] = service.run_text(service.yt_dlp_command() + ["--version"])
    except Exception:
      payload["ytDlpVersion"] = "unavailable"
    payload["poTokenProvider"] = service.po_token_provider_version() or "unavailable"
    payload["bgutilProvider"] = service.package_version("bgutil-ytdlp-pot-provider") or "unavailable"
    payload["chromiumCookieUnlock"] = service.package_version("yt-dlp-ChromeCookieUnlock") or "unavailable"
    payload["poTokenBrowser"] = service.detect_chromium_browser() or "default Chromium"
    payload["cookieSource"] = service.resolve_cookies_browser(service.get_yt_dlp_settings()["cookiesBrowser"])
  return payload


def dispatch(action: str, params: dict, progress_callback=None) -> dict:
  if action == "cancel-request":
    target_request_id = str(params.get("targetRequestId") or "")
    return {"ok": True, "cancelled": service.cancel_request(target_request_id)}
  if action == "cleanup-march-files":
    paths = params.get("paths") if isinstance(params.get("paths"), list) else []
    return service.cleanup_march_files([str(path) for path in paths])
  if action in ("health", "ping"):
    return health_payload()
  if action == "diagnose":
    return health_payload(include_tool_versions=True)

  if action == "settings":
    return service.get_settings_payload()
  if action == "validate-settings":
    return service.validate_yt_dlp_settings(query_from_params(params))
  if action == "set-settings":
    payload = service.set_yt_dlp_settings(query_from_params(params))
    payload["saved"] = True
    return payload

  if action == "choose-download-file":
    return service.choose_download_file(params.get("name"), params.get("extension"))
  if action == "choose-download-dir":
    return service.choose_download_dir()
  if action == "set-download-dir":
    return service.set_download_dir(params.get("path"))
  if action == "download-dir":
    return {"ok": True, "downloadDir": str(service.get_download_dir())}

  if action in ("waveform-url", "download-url"):
    media_url = service.normalize_direct_media_url(params.get("url", ""))
    title = params.get("title", "")
    if action == "download-url":
      return service.download_direct_media(media_url, title, params.get("outputPath"))
    bins = max(200, min(24000, int(params.get("bins", 2400))))
    return service.build_direct_waveform(media_url, bins, title)

  page_url = service.normalize_youtube_watch_url(params.get("url", ""))
  staging = str(params.get("march") or "").lower() in ("1", "true", "yes")
  staging_options = {"staging": True} if staging else {}
  if action == "original-info":
    return service.get_original_audio_info(page_url)
  if action == "waveform":
    bins = max(200, min(24000, int(params.get("bins", 2400))))
    return service.build_waveform(page_url, bins, progress_callback=progress_callback)
  if action == "download-wav":
    markers = service.parse_marker_times(params.get("markers"))
    return service.download_best_wav(page_url, params.get("outputPath"), markers, **staging_options)
  if action == "download-mp3":
    return service.download_best_mp3(page_url, params.get("outputPath"), **staging_options)
  if action == "download-original":
    return service.download_original_audio(page_url, params.get("outputPath"), **staging_options)
  if action == "download-mp4":
    return service.download_best_mp4(page_url, params.get("outputPath"), **staging_options)
  if action == "download-game":
    return service.download_game_video(page_url, params.get("outputPath"), progress_callback=progress_callback, **staging_options)
  if action == "download-aac":
    return service.download_unity_aac(page_url, params.get("outputPath"), progress_callback=progress_callback, **staging_options)
  raise ValueError(f"Unknown native helper action: {action}")


def process_message(message: dict) -> None:
  request_id = str(message.get("requestId") or "")
  action = str(message.get("action") or "")
  params = message.get("params") if isinstance(message.get("params"), dict) else {}
  service.log(f"Native request started: {action or '<missing action>'}")
  keepalive_stop = threading.Event()
  keepalive_thread = threading.Thread(
    target=send_request_keepalives,
    args=(request_id, keepalive_stop),
    name=f"galaktika-keepalive-{request_id}",
    daemon=True,
  )
  keepalive_thread.start()
  try:
    def send_progress(body: dict) -> None:
      send_message({
        "requestId": request_id,
        "ok": True,
        "status": 206,
        "statusText": "Partial Content",
        "event": "waveform-progress" if action == "waveform" else "download-progress",
        "body": body,
        "transport": "native-messaging",
      })

    wants_progress = action in ("waveform", "download-game", "download-aac") and message.get("progress") is True
    with service.native_request_scope(request_id), service.session_cookie_file(params.pop("sessionCookies", None)):
      body = dispatch(action, params, progress_callback=send_progress if wants_progress else None)
    service.log(f"Native request completed: {action or '<missing action>'}")
    ok = body.get("ok", True) is not False if isinstance(body, dict) else True
    send_message({
      "requestId": request_id,
      "ok": ok,
      "status": 200 if ok else 409,
      "statusText": "OK" if ok else "Request declined",
      "body": body,
      "transport": "native-messaging",
    })
    service.log(f"Native response sent: {action or '<missing action>'}")
  except service.RequestCancelledError as exc:
    send_message({
      "requestId": request_id,
      "ok": False,
      "status": 409,
      "statusText": "Cancelled",
      "body": {"error": str(exc), "saved": False, "cancelled": True},
      "transport": "native-messaging",
    })
  except (ValueError, PermissionError, FileNotFoundError, TimeoutError) as exc:
    send_message({
      "requestId": request_id,
      "ok": False,
      "status": 400,
      "statusText": type(exc).__name__,
      "body": {"error": str(exc), "saved": False},
      "transport": "native-messaging",
    })
  except subprocess.CalledProcessError as exc:
    detail = (exc.stderr or exc.stdout or str(exc)).strip()
    send_message({
      "requestId": request_id,
      "ok": False,
      "status": 500,
      "statusText": "Command failed",
      "body": {"error": detail},
      "transport": "native-messaging",
    })
  except Exception as exc:
    service.log(f"Native request {action} failed: {exc}")
    try:
      send_message({
        "requestId": request_id,
        "ok": False,
        "status": 500,
        "statusText": type(exc).__name__,
        "body": {"error": str(exc)},
        "transport": "native-messaging",
      })
    except (BrokenPipeError, OSError, ValueError):
      # The browser already closed the native pipe; there is nowhere to report it.
      pass
  finally:
    keepalive_stop.set()


def main() -> None:
  os.chdir(ROOT)
  service.cleanup_audio_cache()
  service.cleanup_waveform_json_cache()
  service.log(f"Galaktika native helper {HOST_VERSION} connected to the browser (PID {os.getpid()}).")
  executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="galaktika-native")
  try:
    while True:
      try:
        message = read_message()
      except Exception as exc:
        service.log(f"Native input failed: {exc}")
        break
      if message is None:
        break
      service.log(f"Native message received: {message.get('action') or '<missing action>'}")
      if message.get("action") in ("health", "diagnose", "ping", "cancel-request", "cleanup-march-files"):
        process_message(message)
      else:
        executor.submit(process_message, message)
  finally:
    service.request_shutdown()
    executor.shutdown(wait=True, cancel_futures=True)
  service.log("Browser native connection closed; Galaktika helper exiting.")


if __name__ == "__main__":
  main()
