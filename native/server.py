#!/usr/bin/env python3
"""Waveform and download services for the Galaktika native messaging host.

Requirements:
  - yt-dlp on PATH
  - ffmpeg on PATH

This module is imported by native_host.py; it does not open a network listener.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import threading
from contextlib import contextmanager
import tkinter as tk
import urllib.request
from array import array
from pathlib import Path
from tkinter import filedialog
from urllib.parse import parse_qs, unquote, urlparse

HELPER_VERSION = "0.5.7"
REQUEST_COOKIES = threading.local()


@contextmanager
def session_cookie_file(cookies):
  if cookies is None:
    yield
    return
  if not isinstance(cookies, list) or len(cookies) > 1000:
    raise ValueError("Invalid session cookie collection.")
  lines = ["# Netscape HTTP Cookie File"]
  for cookie in cookies:
    domain = str(cookie.get("domain", ""))
    if domain.lstrip(".") != "youtube.com" and not domain.lstrip(".").endswith(".youtube.com"):
      raise ValueError("Session cookie domain must belong to YouTube.")
    fields = [domain, "FALSE" if cookie.get("hostOnly") else "TRUE",
              str(cookie.get("path") or "/"), "TRUE" if cookie.get("secure") else "FALSE",
              str(max(0, int(cookie.get("expirationDate") or 0))),
              str(cookie.get("name", "")), str(cookie.get("value", ""))]
    if any(any(ch in field for ch in "\r\n\t\0") for field in fields):
      raise ValueError("Invalid session cookie field.")
    lines.append("\t".join(fields))
  previous = getattr(REQUEST_COOKIES, "path", None)
  with tempfile.TemporaryDirectory(prefix="galaktika-session-") as directory:
    path = Path(directory) / "cookies.txt"
    try:
      path.write_text("\n".join(lines) + "\n", encoding="utf-8")
      REQUEST_COOKIES.path = str(path)
      yield
    finally:
      REQUEST_COOKIES.path = previous
      path.unlink(missing_ok=True)
SAMPLE_RATE = 2000
PREVIEW_WAVEFORM_BINS = 2400
HIGH_RES_WAVEFORM_BINS = 16000
PREVIEW_AUDIO_REUSE_MAX_BINS = 5000
STALE_AUDIO_CACHE_SECONDS = 15 * 60
STALE_WAVEFORM_CACHE_SECONDS = 30 * 24 * 60 * 60
MAX_WAVEFORM_CACHE_FILES = 300
CACHE_DIR = Path(__file__).resolve().parent / "cache"
AUDIO_CACHE_DIR = CACHE_DIR / "audio"
DOWNLOAD_DIR = Path(__file__).resolve().parent / "downloads"
CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
BGUTIL_SERVER_DIR = Path(__file__).resolve().parent / ".bgutil-provider" / "server"
MAX_DURATION_SECONDS = 60 * 60 * 4
CACHE_VERSION = "native-streaming-waveform-v2"
DELETE_AUDIO_AFTER_WAVEFORM = True
DIRECT_MEDIA_EXTENSIONS = {".aac", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm"}
LEGACY_SOURCE_AUDIO_FORMAT = (
  "worstaudio[acodec^=opus]/"
  "worstaudio[ext=webm]/"
  "worstaudio[acodec^=mp4a]/"
  "worstaudio[ext=m4a]/"
  "worstaudio"
)
DEFAULT_SOURCE_AUDIO_FORMAT = "bestaudio[acodec^=opus]/bestaudio"
DEFAULT_PREFETCH_FORMAT_SORT = "+size,+br"
DEFAULT_BEST_WAV_FORMAT = "bestaudio/best"
DEFAULT_BEST_MP3_FORMAT = "bestaudio/best"
DEFAULT_ORIGINAL_AUDIO_FORMAT = "bestaudio/best"
DEFAULT_MP4_FORMAT = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best"
GAME_FPS = 12
GAME_HEIGHT = 160
GAME_CRF = 38
GAME_AUDIO_BITRATE = "64k"
UNITY_AAC_SAMPLE_RATE = 48000
DEFAULT_COOKIES_BROWSER = "auto"
DEFAULT_REMOTE_COMPONENTS = "bundled"
DEFAULT_PO_TOKEN_BROWSER_PATH = "auto"
YOUTUBE_STREAM_RETRY_DELAYS = (0.75, 1.5)
WAVEFORM_BUILD_LOCKS: dict[str, threading.Lock] = {}
WAVEFORM_BUILD_LOCKS_GUARD = threading.Lock()
SHUTDOWN_EVENT = threading.Event()
ACTIVE_PROCESSES: set[subprocess.Popen] = set()
ACTIVE_PROCESSES_LOCK = threading.Lock()
REQUEST_CONTEXT = threading.local()
REQUEST_CANCEL_EVENTS: dict[str, threading.Event] = {}
REQUEST_PROCESSES: dict[str, set[subprocess.Popen]] = {}


class RequestCancelledError(RuntimeError):
  pass


def log(message: str) -> None:
  print(message, file=sys.stderr, flush=True)


def register_process(process: subprocess.Popen) -> subprocess.Popen:
  with ACTIVE_PROCESSES_LOCK:
    ACTIVE_PROCESSES.add(process)
    request_id = str(getattr(REQUEST_CONTEXT, "request_id", "") or "")
    if request_id:
      REQUEST_PROCESSES.setdefault(request_id, set()).add(process)
  return process


def unregister_process(process: subprocess.Popen | None) -> None:
  if process is None:
    return
  with ACTIVE_PROCESSES_LOCK:
    ACTIVE_PROCESSES.discard(process)
    for processes in REQUEST_PROCESSES.values():
      processes.discard(process)


@contextmanager
def native_request_scope(request_id: str):
  request_id = str(request_id or "")
  event = threading.Event()
  with ACTIVE_PROCESSES_LOCK:
    REQUEST_CANCEL_EVENTS[request_id] = event
    REQUEST_PROCESSES.setdefault(request_id, set())
  previous_id = getattr(REQUEST_CONTEXT, "request_id", "")
  previous_event = getattr(REQUEST_CONTEXT, "cancel_event", None)
  REQUEST_CONTEXT.request_id = request_id
  REQUEST_CONTEXT.cancel_event = event
  try:
    yield
  finally:
    REQUEST_CONTEXT.request_id = previous_id
    REQUEST_CONTEXT.cancel_event = previous_event
    with ACTIVE_PROCESSES_LOCK:
      REQUEST_CANCEL_EVENTS.pop(request_id, None)
      REQUEST_PROCESSES.pop(request_id, None)


def request_cancelled() -> bool:
  event = getattr(REQUEST_CONTEXT, "cancel_event", None)
  return bool(event and event.is_set())


def raise_if_request_cancelled() -> None:
  if request_cancelled():
    raise RequestCancelledError("The current MARCH item was skipped.")


def cancel_request(request_id: str) -> bool:
  with ACTIVE_PROCESSES_LOCK:
    event = REQUEST_CANCEL_EVENTS.get(str(request_id or ""))
    processes = list(REQUEST_PROCESSES.get(str(request_id or ""), set()))
    if event:
      event.set()
  for process in processes:
    if process.poll() is None:
      try:
        process.terminate()
      except OSError:
        pass
  return event is not None


def cleanup_march_files(paths: list[str]) -> dict:
  download_root = get_download_dir().resolve()
  removed = 0
  for raw_path in paths:
    try:
      candidate = Path(str(raw_path)).expanduser().resolve()
      candidate.relative_to(download_root)
    except (OSError, ValueError):
      continue
    if candidate.is_file():
      candidate.unlink(missing_ok=True)
      removed += 1
  return {"ok": True, "removed": removed}


def request_shutdown() -> None:
  SHUTDOWN_EVENT.set()
  with ACTIVE_PROCESSES_LOCK:
    processes = list(ACTIVE_PROCESSES)
  for process in processes:
    if process.poll() is None:
      try:
        process.terminate()
      except OSError:
        pass
  for process in processes:
    if process.poll() is None:
      try:
        process.wait(timeout=1)
      except (OSError, subprocess.TimeoutExpired):
        try:
          process.kill()
        except OSError:
          pass


def normalize_youtube_watch_url(page_url: str) -> str:
  raw_url = unquote((page_url or "").strip().strip("'\""))
  parsed = urlparse(raw_url)
  host = parsed.netloc.lower()
  path = parsed.path.rstrip("/")
  query = parse_qs(parsed.query)

  if host in ("www.youtube.com", "m.youtube.com", "youtube.com") and "v" in query:
    video_id = (query.get("v") or [""])[0].strip()
    if video_id:
      return f"https://www.youtube.com/watch?v={video_id}"

  if host in ("www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com") and "/embed/" in path:
    video_id = path.split("/embed/", 1)[1].split("/", 1)[0].strip()
    if video_id:
      return f"https://www.youtube.com/watch?v={video_id}"

  if host in ("youtu.be", "www.youtu.be"):
    video_id = parsed.path.strip("/").split("/", 1)[0].strip()
    if video_id:
      return f"https://www.youtube.com/watch?v={video_id}"

  raise ValueError("Only YouTube watch or embed URLs are accepted.")


def sanitize_filename_part(value: str) -> str:
  value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
  value = re.sub(r"\s+", " ", value).strip(" .")
  return value or "audio"


def abbreviate_video_title(value: str) -> str:
  parts = re.findall(r"[^\W_]+", str(value or ""), flags=re.UNICODE)
  abbreviated = "".join(part if part.isdecimal() else part[0].upper() for part in parts if part)
  return sanitize_filename_part(abbreviated) if abbreviated else "YT"


def printed_video_title(output: str, marker: str) -> str:
  for line in output.splitlines():
    if not line.startswith(marker):
      continue
    try:
      value = json.loads(line[len(marker):])
    except (json.JSONDecodeError, TypeError, ValueError):
      continue
    if str(value or "").strip():
      return str(value).strip()
  return "YouTube video"


def normalize_direct_media_url(media_url: str) -> str:
  raw_url = unquote((media_url or "").strip().strip("'\""))
  parsed = urlparse(raw_url)
  if parsed.scheme not in ("http", "https"):
    raise ValueError("Only http and https media URLs are accepted.")
  suffix = Path(parsed.path).suffix.lower()
  if suffix not in DIRECT_MEDIA_EXTENSIONS:
    raise ValueError("Only direct audio/video media URLs are accepted.")
  return raw_url


def unique_path(path: Path) -> Path:
  if not path.exists():
    return path
  stem = path.stem
  suffix = path.suffix
  for index in range(2, 1000):
    candidate = path.with_name(f"{stem} ({index}){suffix}")
    if not candidate.exists():
      return candidate
  raise FileExistsError(f"Could not create a unique filename for {path}")


def load_config() -> dict:
  if not CONFIG_PATH.exists():
    return {}
  try:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
  except Exception:
    return {}


def save_config(config: dict) -> None:
  CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


def validate_setting(value: str | None, name: str, default: str, max_length: int = 500) -> str:
  if value is None:
    return default
  cleaned = str(value).strip()
  if not cleaned:
    return default
  if len(cleaned) > max_length:
    raise ValueError(f"{name} is too long.")
  if any(ord(char) < 32 for char in cleaned):
    raise ValueError(f"{name} cannot contain line breaks or control characters.")
  return cleaned


def validate_setting_value(value: str, name: str) -> None:
  if value.startswith("-"):
    raise ValueError(f"{name} cannot start with a command-line option.")
  if name == "Remote components" and not re.fullmatch(r"[A-Za-z0-9._,:/+\-]+", value):
    raise ValueError("Remote components contains unsupported characters.")


def yt_dlp_executable() -> str:
  dedicated = Path("C:/ytdl/yt-dlp.exe")
  if os.name == "nt" and dedicated.is_file():
    return str(dedicated)
  return shutil.which("yt-dlp") or "yt-dlp"


def yt_dlp_command() -> list[str]:
  """Prefer the helper venv so yt-dlp can discover its PO-token plugin."""
  if importlib.util.find_spec("yt_dlp") is not None:
    return [sys.executable, "-m", "yt_dlp"]
  return [yt_dlp_executable()]


def detect_chromium_browser() -> str | None:
  if os.name != "nt":
    for name in ("thorium", "chromium", "google-chrome", "chrome"):
      executable = shutil.which(name)
      if executable:
        return executable
    return None

  local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
  program_files = Path(os.environ.get("PROGRAMFILES", ""))
  program_files_x86 = Path(os.environ.get("PROGRAMFILES(X86)", ""))
  candidates = (
    local_app_data / "Thorium" / "Application" / "thorium.exe",
    local_app_data / "Programs" / "Thorium" / "thorium.exe",
    program_files / "Thorium" / "Application" / "thorium.exe",
    program_files_x86 / "Thorium" / "Application" / "thorium.exe",
    local_app_data / "Chromium" / "Application" / "chrome.exe",
    program_files / "Google" / "Chrome" / "Application" / "chrome.exe",
    program_files_x86 / "Google" / "Chrome" / "Application" / "chrome.exe",
  )
  return next((str(path) for path in candidates if path.is_file()), None)


def detect_thorium_profile() -> str | None:
  if os.name != "nt":
    return None
  profile = Path(os.environ.get("LOCALAPPDATA", "")) / "Thorium" / "User Data"
  return str(profile) if (profile / "Local State").is_file() else None


def resolve_cookies_browser(value: str) -> str:
  configured = str(value or "").strip()
  if configured.lower() != "auto":
    return configured
  thorium_profile = detect_thorium_profile()
  return f"chromium:{thorium_profile}" if thorium_profile else "firefox"


def detect_deno() -> str | None:
  dedicated = Path("C:/ytdl/deno.exe")
  if os.name == "nt" and dedicated.is_file():
    return str(dedicated)
  return shutil.which("deno")


def po_token_provider_version() -> str | None:
  try:
    return importlib.metadata.version("yt-dlp-getpot-wpc")
  except importlib.metadata.PackageNotFoundError:
    return None


def package_version(distribution: str) -> str | None:
  try:
    return importlib.metadata.version(distribution)
  except importlib.metadata.PackageNotFoundError:
    return None


def get_yt_dlp_settings(config: dict | None = None) -> dict:
  config = config if config is not None else load_config()
  configured_source = config.get("sourceAudioFormat")
  if configured_source == LEGACY_SOURCE_AUDIO_FORMAT:
    configured_source = DEFAULT_SOURCE_AUDIO_FORMAT
  return {
    "sourceAudioFormat": validate_setting(
      configured_source,
      "Prefetch format selector",
      DEFAULT_SOURCE_AUDIO_FORMAT,
    ),
    "bestWavFormat": validate_setting(
      config.get("bestWavFormat"),
      "WAV format selector",
      DEFAULT_BEST_WAV_FORMAT,
    ),
    "cookiesBrowser": validate_setting(
      config.get("cookiesBrowser"),
      "Cookies browser",
      DEFAULT_COOKIES_BROWSER,
      80,
    ),
    "remoteComponents": validate_setting(
      config.get("remoteComponents"),
      "Remote components",
      DEFAULT_REMOTE_COMPONENTS,
      160,
    ),
    "poTokenBrowserPath": validate_setting(
      config.get("poTokenBrowserPath"),
      "PO-token browser path",
      DEFAULT_PO_TOKEN_BROWSER_PATH,
      500,
    ),
  }


def settings_from_query(query: dict[str, list[str]]) -> dict:
  if (query.get("reset") or [""])[0] == "1":
    return get_yt_dlp_settings({})
  settings = {
    "sourceAudioFormat": validate_setting(
      (query.get("sourceAudioFormat") or [""])[0],
      "Prefetch format selector",
      DEFAULT_SOURCE_AUDIO_FORMAT,
    ),
    "bestWavFormat": validate_setting(
      (query.get("bestWavFormat") or [""])[0],
      "WAV format selector",
      DEFAULT_BEST_WAV_FORMAT,
    ),
    "cookiesBrowser": validate_setting(
      (query.get("cookiesBrowser") or [""])[0],
      "Cookies browser",
      DEFAULT_COOKIES_BROWSER,
      80,
    ),
    "remoteComponents": validate_setting(
      (query.get("remoteComponents") or [""])[0],
      "Remote components",
      DEFAULT_REMOTE_COMPONENTS,
      160,
    ),
    "poTokenBrowserPath": validate_setting(
      (query.get("poTokenBrowserPath") or [""])[0],
      "PO-token browser path",
      DEFAULT_PO_TOKEN_BROWSER_PATH,
      500,
    ),
  }
  validate_setting_value(settings["sourceAudioFormat"], "Prefetch format selector")
  validate_setting_value(settings["bestWavFormat"], "WAV format selector")
  validate_setting_value(settings["cookiesBrowser"], "Cookies browser")
  validate_setting_value(settings["remoteComponents"], "Remote components")
  validate_setting_value(settings["poTokenBrowserPath"], "PO-token browser path")
  return settings


def validate_yt_dlp_commands(settings: dict, raw_page_url: str | None = None) -> dict:
  yt_dlp = yt_dlp_command()
  ffmpeg = shutil.which("ffmpeg")
  if not yt_dlp:
    raise FileNotFoundError("yt-dlp was not found on PATH.")
  if not ffmpeg:
    raise FileNotFoundError("ffmpeg was not found on PATH.")

  version = run_text(yt_dlp + ["--version"])
  result = {
    "ok": True,
    "mode": "local",
    "message": "Command structure, yt-dlp, and ffmpeg were validated.",
    "ytDlpVersion": version,
    "poTokenProvider": po_token_provider_version() or "unavailable",
  }
  if not raw_page_url:
    return result

  page_url = normalize_youtube_watch_url(raw_page_url)
  probes = (
    ("Prefetch command", settings["sourceAudioFormat"], True),
    ("WAV command", settings["bestWavFormat"], False),
  )
  for label, selector, prefer_smallest in probes:
    command = yt_dlp_common_args(settings, include_cookies=not prefer_smallest) + [
      "--simulate",
      "--skip-download",
      "--no-warnings",
      "--print",
      "%(id)s",
      "-f",
      selector,
    ]
    if prefer_smallest:
      command.extend(["-S", DEFAULT_PREFETCH_FORMAT_SORT])
    command.append(page_url)
    try:
      run_capture(command, timeout=60)
    except subprocess.TimeoutExpired as exc:
      raise ValueError(f"{label} validation timed out without saving settings.") from exc
    except subprocess.CalledProcessError as exc:
      if prefer_smallest:
        cookie_command = yt_dlp_common_args(settings, include_cookies=True) + command[len(yt_dlp_common_args(settings, include_cookies=False)):]
        try:
          run_capture(cookie_command, timeout=60)
          continue
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
          pass
      detail = (exc.stderr or exc.stdout or str(exc)).strip()
      raise ValueError(f"{label} validation failed: {detail}") from exc

  result["mode"] = "dry-run"
  result["message"] = "Prefetch and WAV commands passed yt-dlp dry-run validation; no media was downloaded."
  return result


def validate_yt_dlp_settings(query: dict[str, list[str]]) -> dict:
  settings = settings_from_query(query)
  validation = validate_yt_dlp_commands(settings, (query.get("url") or [""])[0])
  payload = get_settings_payload(settings)
  payload["validation"] = validation
  return payload


def set_yt_dlp_settings(query: dict[str, list[str]]) -> dict:
  settings = settings_from_query(query)
  config = load_config()
  if (query.get("reset") or [""])[0] == "1":
    for key in ("sourceAudioFormat", "bestWavFormat", "cookiesBrowser", "remoteComponents", "poTokenBrowserPath"):
      config.pop(key, None)
  else:
    config.update(settings)
  save_config(config)
  payload = get_settings_payload(settings)
  payload["validation"] = {
    "ok": True,
    "mode": "unverified",
    "message": "Settings saved without command verification.",
  }
  return payload


def yt_dlp_common_args(settings: dict, include_cookies: bool = True) -> list[str]:
  command = yt_dlp_command()
  remote_components = str(settings.get("remoteComponents") or "").strip()
  if remote_components.lower() not in ("", "bundled", "none", "off"):
    command.extend(["--remote-components", remote_components])
  if include_cookies:
    session_path = getattr(REQUEST_COOKIES, "path", None)
    if session_path:
      command.extend(["--cookies", session_path])
    else:
      command.extend(["--cookies-from-browser", resolve_cookies_browser(settings["cookiesBrowser"])])
  deno = detect_deno()
  if deno:
    command.extend(["--js-runtimes", f"deno:{deno}"])
  if BGUTIL_SERVER_DIR.is_dir():
    command.extend(["--extractor-args", "youtube:player_client=mweb"])
    command.extend([
      "--extractor-args",
      f"youtubepot-bgutilscript:server_home={BGUTIL_SERVER_DIR}",
    ])
  browser_path = str(settings.get("poTokenBrowserPath") or "").strip()
  if browser_path.lower() == "auto":
    browser_path = detect_chromium_browser() or ""
  if browser_path.lower() not in ("", "none", "off"):
    command.extend(["--extractor-args", f"youtubepot-wpc:browser_path={browser_path}"])
  command.append("--no-playlist")
  return command


def quote_command_arg(value: str) -> str:
  if not value or re.search(r'[\s"&<>|]', value):
    return '"' + value.replace('"', r'\"') + '"'
  return value


def command_text(command: list[str]) -> str:
  return " ".join(quote_command_arg(str(part)) for part in command)


def get_settings_payload(settings: dict | None = None) -> dict:
  settings = settings or get_yt_dlp_settings()
  wav_output = str(get_download_dir() / "%(title).180B.%(ext)s")
  return {
    "ok": True,
    "settings": settings,
    "defaults": {
      "sourceAudioFormat": DEFAULT_SOURCE_AUDIO_FORMAT,
      "bestWavFormat": DEFAULT_BEST_WAV_FORMAT,
      "cookiesBrowser": DEFAULT_COOKIES_BROWSER,
      "remoteComponents": DEFAULT_REMOTE_COMPONENTS,
      "poTokenBrowserPath": DEFAULT_PO_TOKEN_BROWSER_PATH,
    },
    "commands": {
      "prefetch": command_text(yt_dlp_common_args(settings, include_cookies=False) + [
        "-f",
        settings["sourceAudioFormat"],
        "-S",
        DEFAULT_PREFETCH_FORMAT_SORT,
        "-o",
        "-",
        "<youtube-watch-url>",
      ]) + " | ffmpeg -i pipe:0 -vn -ac 1 -ar 2000 -f s16le pipe:1",
      "downloadWav": command_text(yt_dlp_common_args(settings) + [
        "-f",
        settings["bestWavFormat"],
        "--embed-metadata",
        "--extract-audio",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        wav_output,
        "<youtube-watch-url>",
      ]),
      "downloadMp3": command_text(yt_dlp_common_args(settings) + [
        "-f",
        DEFAULT_BEST_MP3_FORMAT,
        "--embed-metadata",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "-o",
        str(get_download_dir() / "%(title).180B.%(ext)s"),
        "<youtube-watch-url>",
      ]),
      "downloadMp4": command_text(yt_dlp_common_args(settings) + [
        "-f",
        DEFAULT_MP4_FORMAT,
        "--embed-metadata",
        "--merge-output-format",
        "mp4",
        "-o",
        str(get_download_dir() / "%(title).180B.%(ext)s"),
        "<youtube-watch-url>",
      ]),
    },
  }


def get_download_dir() -> Path:
  configured = load_config().get("downloadDir")
  if configured:
    return Path(configured).expanduser().resolve()
  return DOWNLOAD_DIR


def set_download_dir(directory: str | None) -> dict:
  if not directory or not directory.strip():
    raise ValueError("Download directory cannot be empty.")
  path = Path(directory).expanduser().resolve()
  path.mkdir(parents=True, exist_ok=True)
  if not path.is_dir():
    raise ValueError(f"Path is not a directory: {path}")
  config = load_config()
  config["downloadDir"] = str(path)
  save_config(config)
  return {"ok": True, "downloadDir": str(path)}


def choose_download_dir() -> dict:
  current = get_download_dir()
  current.mkdir(parents=True, exist_ok=True)

  root = tk.Tk()
  root.withdraw()
  root.attributes("-topmost", True)
  try:
    selected = filedialog.askdirectory(
      title="Choose Galaktika MARCH download directory",
      initialdir=str(current),
      mustexist=False,
      parent=root,
    )
  finally:
    root.destroy()

  if not selected:
    return {"ok": False, "cancelled": True, "downloadDir": str(current)}
  return set_download_dir(selected)


def normalize_extension(extension: str | None, fallback: str = ".wav") -> str:
  cleaned = (extension or fallback).strip()
  if not cleaned:
    cleaned = fallback
  if not cleaned.startswith("."):
    cleaned = f".{cleaned}"
  cleaned = re.sub(r"[^A-Za-z0-9.]", "", cleaned)[:12]
  return cleaned if cleaned.startswith(".") and len(cleaned) > 1 else fallback


def validate_output_path(output_path: str | None, default_extension: str = ".wav") -> Path | None:
  if not output_path or not output_path.strip():
    return None
  path = Path(output_path).expanduser().resolve()
  extension = normalize_extension(default_extension)
  if not path.suffix:
    path = path.with_suffix(extension)
  path.parent.mkdir(parents=True, exist_ok=True)
  if path.exists() and path.is_dir():
    raise ValueError(f"Output path is a directory: {path}")
  config = load_config()
  config["downloadDir"] = str(path.parent)
  save_config(config)
  return path


def choose_download_file(name: str | None = None, extension: str | None = None) -> dict:
  current = get_download_dir()
  current.mkdir(parents=True, exist_ok=True)
  default_extension = normalize_extension(extension)
  initial_name = sanitize_filename_part(name or "Galaktika download")
  if Path(initial_name).suffix.lower() != default_extension.lower():
    initial_name = f"{Path(initial_name).stem}{default_extension}"

  root = tk.Tk()
  root.withdraw()
  root.attributes("-topmost", True)
  try:
    media_label = "Video file" if default_extension.lower() == ".mp4" else "Audio file"
    selected = filedialog.asksaveasfilename(
      title="Save Galaktika media as",
      initialdir=str(current),
      initialfile=initial_name,
      defaultextension=default_extension,
      filetypes=[(media_label, f"*{default_extension}"), ("All files", "*.*")],
      parent=root,
    )
  finally:
    root.destroy()

  if not selected:
    return {"ok": False, "cancelled": True, "downloadDir": str(current)}
  output_path = validate_output_path(selected, default_extension)
  return {
    "ok": True,
    "outputPath": str(output_path),
    "downloadDir": str(output_path.parent),
    "filename": output_path.name,
  }


def run_capture(command: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
  raise_if_request_cancelled()
  process = register_process(subprocess.Popen(
    command,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    errors="replace",
  ))
  deadline = time.monotonic() + timeout if timeout is not None else None
  try:
    while True:
      try:
        stdout, stderr = process.communicate(timeout=0.25)
        break
      except subprocess.TimeoutExpired:
        if SHUTDOWN_EVENT.is_set() or request_cancelled():
          process.terminate()
          try:
            process.wait(timeout=2)
          except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
          if request_cancelled():
            raise RequestCancelledError("The current MARCH item was skipped.")
          raise RuntimeError("Galaktika closed; the native helper request was cancelled.")
        if deadline is not None and time.monotonic() >= deadline:
          process.kill()
          stdout, stderr = process.communicate()
          raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr)
    raise_if_request_cancelled()
    if process.returncode != 0:
      raise subprocess.CalledProcessError(process.returncode, command, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(command, process.returncode, stdout=stdout, stderr=stderr)
  finally:
    unregister_process(process)


def run_text(command: list[str]) -> str:
  completed = run_capture(command)
  return completed.stdout.strip()


def run_streaming_capture(command: list[str], stdout_callback=None, stderr_callback=None) -> subprocess.CompletedProcess:
  raise_if_request_cancelled()
  process = register_process(subprocess.Popen(
    command,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
  ))
  stdout_lines: list[str] = []
  stderr_lines: list[str] = []

  def drain(stream, lines: list[str], callback) -> None:
    try:
      for line in iter(stream.readline, ""):
        lines.append(line)
        if callback:
          callback(line.rstrip("\r\n"))
    finally:
      stream.close()

  stdout_thread = threading.Thread(target=drain, args=(process.stdout, stdout_lines, stdout_callback), daemon=True)
  stderr_thread = threading.Thread(target=drain, args=(process.stderr, stderr_lines, stderr_callback), daemon=True)
  stdout_thread.start()
  stderr_thread.start()
  try:
    while True:
      try:
        return_code = process.wait(timeout=0.25)
        break
      except subprocess.TimeoutExpired:
        if SHUTDOWN_EVENT.is_set() or request_cancelled():
          process.terminate()
          try:
            process.wait(timeout=2)
          except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
          if request_cancelled():
            raise RequestCancelledError("The current MARCH item was skipped.")
          raise RuntimeError("Galaktika closed; the native helper request was cancelled.")
    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)
    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_lines)
    raise_if_request_cancelled()
    if return_code != 0:
      raise subprocess.CalledProcessError(return_code, command, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(command, return_code, stdout=stdout, stderr=stderr)
  finally:
    unregister_process(process)


def cache_key(url: str, bins: int) -> Path:
  settings = get_yt_dlp_settings()
  settings_key = "|".join([
    settings["sourceAudioFormat"],
    settings["cookiesBrowser"],
    settings["remoteComponents"],
  ])
  digest = hashlib.sha256(f"{CACHE_VERSION}|{settings_key}|{url}|{bins}".encode("utf-8")).hexdigest()
  return CACHE_DIR / f"{digest}.json"


def audio_cache_base(page_url: str) -> Path:
  settings = get_yt_dlp_settings()
  settings_key = "|".join([
    settings["sourceAudioFormat"],
    settings["cookiesBrowser"],
    settings["remoteComponents"],
  ])
  digest = hashlib.sha256(f"{CACHE_VERSION}|audio|{settings_key}|{page_url}".encode("utf-8")).hexdigest()
  return AUDIO_CACHE_DIR / digest


def direct_media_cache_key(media_url: str, bins: int) -> Path:
  digest = hashlib.sha256(f"{CACHE_VERSION}|direct|{media_url}|{bins}".encode("utf-8")).hexdigest()
  return CACHE_DIR / f"{digest}.json"


def direct_audio_cache_base(media_url: str) -> Path:
  digest = hashlib.sha256(f"{CACHE_VERSION}|direct-audio|{media_url}".encode("utf-8")).hexdigest()
  return AUDIO_CACHE_DIR / digest


def cleanup_audio_cache(max_age_seconds: float | None = None) -> None:
  if not DELETE_AUDIO_AFTER_WAVEFORM or not AUDIO_CACHE_DIR.exists():
    return
  now = time.time()
  for path in AUDIO_CACHE_DIR.glob("*"):
    if not path.is_file():
      continue
    if max_age_seconds is not None and now - path.stat().st_mtime < max_age_seconds:
      continue
    try:
      path.unlink()
      log(f"Deleted temporary audio file: {path}")
    except OSError as exc:
      log(f"Could not delete temporary audio file {path}: {exc}")


def delete_cache_file(path: Path, label: str = "cache") -> None:
  try:
    if path.exists() and path.is_file():
      path.unlink()
      log(f"Deleted {label} file: {path}")
  except OSError as exc:
    log(f"Could not delete {label} file {path}: {exc}")


def cleanup_waveform_json_cache(max_age_seconds: float | None = STALE_WAVEFORM_CACHE_SECONDS) -> None:
  if not CACHE_DIR.exists():
    return
  now = time.time()
  files = [path for path in CACHE_DIR.glob("*.json") if path.is_file()]
  kept = []
  for path in files:
    try:
      if max_age_seconds is not None and now - path.stat().st_mtime > max_age_seconds:
        delete_cache_file(path, "stale waveform cache")
      else:
        kept.append(path)
    except OSError as exc:
      log(f"Could not inspect waveform cache file {path}: {exc}")
  if len(kept) <= MAX_WAVEFORM_CACHE_FILES:
    return
  overflow = sorted(kept, key=lambda path: path.stat().st_mtime)[:len(kept) - MAX_WAVEFORM_CACHE_FILES]
  for path in overflow:
    delete_cache_file(path, "overflow waveform cache")


def cleanup_redundant_preview_cache(current_cache: Path, preview_cache: Path) -> None:
  if current_cache.resolve() == preview_cache.resolve():
    return
  delete_cache_file(preview_cache, "redundant preview waveform cache")


def probe_duration(audio_path: Path) -> float | None:
  try:
    output = run_text([
      "ffprobe", "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path),
    ])
    duration = float(output)
    return duration if math.isfinite(duration) else None
  except Exception:
    return None


def probe_audio_bitrate(audio_path: Path) -> int:
  try:
    output = run_text([
      "ffprobe", "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=bit_rate:format=bit_rate,duration",
      "-of", "json", str(audio_path),
    ])
    payload = json.loads(output)
  except Exception as exc:
    raise RuntimeError("Could not inspect the source audio bitrate.") from exc

  candidates = []
  streams = payload.get("streams") if isinstance(payload, dict) else None
  if isinstance(streams, list) and streams:
    candidates.append(streams[0].get("bit_rate"))
  media_format = payload.get("format") if isinstance(payload, dict) else None
  if isinstance(media_format, dict):
    candidates.append(media_format.get("bit_rate"))
  for value in candidates:
    try:
      bitrate = int(float(value))
    except (TypeError, ValueError):
      continue
    if bitrate > 0:
      return bitrate

  try:
    duration = float(media_format.get("duration")) if isinstance(media_format, dict) else 0.0
    if math.isfinite(duration) and duration > 0:
      bitrate = round((audio_path.stat().st_size * 8) / duration)
      if bitrate > 0:
        return bitrate
  except (OSError, TypeError, ValueError):
    pass
  raise RuntimeError("The source audio bitrate could not be determined.")


def parse_marker_times(value: str | None) -> list[float]:
  if not value:
    return []
  try:
    raw_markers = json.loads(value)
  except json.JSONDecodeError:
    raw_markers = [part.strip() for part in value.split(",")]
  if not isinstance(raw_markers, list):
    return []
  markers = []
  for marker in raw_markers:
    try:
      time_value = float(marker)
    except (TypeError, ValueError):
      continue
    if math.isfinite(time_value) and time_value >= 0:
      markers.append(time_value)
  return sorted(set(round(marker, 6) for marker in markers))


def wav_sample_rate(path: Path) -> int:
  try:
    output = run_text([
      "ffprobe", "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate",
      "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ])
    sample_rate = int(float(output))
    return sample_rate if sample_rate > 0 else 44100
  except Exception:
    return 44100


def wav_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
  if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
    raise ValueError("Downloaded file is not a RIFF/WAVE file.")
  chunks = []
  offset = 12
  while offset + 8 <= len(data):
    chunk_id = data[offset:offset + 4]
    chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
    chunk_start = offset + 8
    chunk_end = min(chunk_start + chunk_size, len(data))
    chunks.append((chunk_id, data[chunk_start:chunk_end]))
    offset = chunk_start + chunk_size + (chunk_size % 2)
  return chunks


def build_wav_chunk(chunk_id: bytes, payload: bytes) -> bytes:
  padding = b"\x00" if len(payload) % 2 else b""
  return chunk_id + struct.pack("<I", len(payload)) + payload + padding


def embed_wav_cue_markers(path: Path, marker_times: list[float]) -> int:
  if not marker_times:
    return 0
  sample_rate = wav_sample_rate(path)
  data = path.read_bytes()
  chunks = [(chunk_id, payload) for chunk_id, payload in wav_chunks(data) if chunk_id != b"cue "]
  data_chunk_id = struct.unpack("<I", b"data")[0]
  cue_entries = []
  for index, seconds in enumerate(marker_times, start=1):
    sample_offset = max(0, int(round(seconds * sample_rate)))
    cue_entries.append(struct.pack("<IIIIII", index, sample_offset, data_chunk_id, 0, 0, sample_offset))
  cue_payload = struct.pack("<I", len(cue_entries)) + b"".join(cue_entries)
  output = b"WAVE" + b"".join(build_wav_chunk(chunk_id, payload) for chunk_id, payload in chunks) + build_wav_chunk(b"cue ", cue_payload)
  riff = b"RIFF" + struct.pack("<I", len(output)) + output
  backup = path.with_suffix(path.suffix + ".bak")
  shutil.copy2(path, backup)
  try:
    path.write_bytes(riff)
    backup.unlink(missing_ok=True)
  except Exception:
    shutil.copy2(backup, path)
    backup.unlink(missing_ok=True)
    raise
  return len(cue_entries)


def waveform_build_lock(page_url: str) -> threading.Lock:
  with WAVEFORM_BUILD_LOCKS_GUARD:
    return WAVEFORM_BUILD_LOCKS.setdefault(page_url, threading.Lock())


def read_stream_metadata(metadata_path: Path, process: subprocess.Popen, timeout_seconds: float = 60) -> dict:
  deadline = time.monotonic() + timeout_seconds
  while time.monotonic() < deadline:
    if metadata_path.exists() and metadata_path.stat().st_size:
      line = metadata_path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
      parts = line.split("\t", 3)
      if len(parts) == 4:
        duration, title, format_id, extension = (json.loads(part) for part in parts)
        return {
          "duration": float(duration) if duration is not None else None,
          "title": str(title or "YouTube audio"),
          "formatId": str(format_id or ""),
          "extension": str(extension or ""),
        }
    if process.poll() is not None:
      stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
      raise RuntimeError(stderr.strip() or "yt-dlp exited before streaming metadata was available.")
    time.sleep(0.05)
  process.kill()
  raise TimeoutError("yt-dlp did not provide streaming metadata in time.")


def decode_pcm_peak_stream(
  stream,
  duration: float,
  bins: int,
  progress_callback=None,
  progress_bins: int = PREVIEW_WAVEFORM_BINS,
) -> tuple[list[float], float]:
  peaks = [0.0 for _ in range(bins)]
  samples_per_bin = max(1, math.ceil((duration * SAMPLE_RATE) / bins))
  partial_peaks = [0.0 for _ in range(progress_bins)] if progress_callback else None
  partial_samples_per_bin = max(1, math.ceil((duration * SAMPLE_RATE) / progress_bins))
  partial_sent = 0
  last_progress_at = 0.0
  sample_index = 0
  bin_index = 0
  while True:
    chunk = stream.read(16 * 1024 if progress_callback else 64 * 1024)
    if not chunk:
      break
    samples = array("h")
    samples.frombytes(chunk[:len(chunk) - (len(chunk) % 2)])
    if sys.byteorder != "little":
      samples.byteswap()
    for sample in samples:
      amplitude = abs(sample) / 32768
      if amplitude > peaks[bin_index]:
        peaks[bin_index] = amplitude
      if partial_peaks is not None:
        partial_index = min(progress_bins - 1, sample_index // partial_samples_per_bin)
        if amplitude > partial_peaks[partial_index]:
          partial_peaks[partial_index] = amplitude
      sample_index += 1
      bin_index = min(bins - 1, sample_index // samples_per_bin)

    if partial_peaks is not None:
      completed = min(progress_bins, sample_index // partial_samples_per_bin)
      now = time.monotonic()
      if completed > partial_sent and (partial_sent == 0 or now - last_progress_at >= 0.10):
        progress_callback({
          "startBin": partial_sent,
          "peaks": [round(value, 4) for value in partial_peaks[partial_sent:completed]],
          "completedBins": completed,
          "totalBins": progress_bins,
          "decodedSeconds": round(sample_index / SAMPLE_RATE, 3),
          "duration": duration,
        })
        partial_sent = completed
        last_progress_at = now

  if partial_peaks is not None:
    progress_callback({
      "startBin": partial_sent,
      "peaks": [round(value, 4) for value in partial_peaks[partial_sent:]],
      "completedBins": progress_bins,
      "totalBins": progress_bins,
      "decodedSeconds": round(sample_index / SAMPLE_RATE, 3),
      "duration": duration,
      "complete": True,
    })
  maximum = max(peaks) or 1
  return [round(value / maximum, 4) for value in peaks], sample_index / SAMPLE_RATE


def downsample_peaks(source: list[float], bins: int) -> list[float]:
  if bins >= len(source):
    return list(source)
  peaks = [0.0 for _ in range(bins)]
  for index, value in enumerate(source):
    target = min(bins - 1, (index * bins) // len(source))
    if value > peaks[target]:
      peaks[target] = value
  return [round(value, 4) for value in peaks]


def _stream_youtube_waveforms_attempt(
  page_url: str,
  bins_values: list[int],
  include_cookies: bool,
  progress_callback=None,
) -> dict[int, dict]:
  CACHE_DIR.mkdir(exist_ok=True)
  settings = get_yt_dlp_settings()
  target_bins = max(bins_values)
  metadata_file = tempfile.NamedTemporaryFile(prefix="galaktika-stream-", suffix=".txt", dir=CACHE_DIR, delete=False)
  metadata_path = Path(metadata_file.name)
  metadata_file.close()
  metadata_path.unlink(missing_ok=True)
  metadata_template = "before_dl:%(duration)j\t%(title)j\t%(format_id)j\t%(ext)j"
  yt_dlp_command = yt_dlp_common_args(settings, include_cookies=include_cookies) + [
    "--quiet", "--no-warnings", "--no-progress",
    "-f", settings["sourceAudioFormat"], "-S", DEFAULT_PREFETCH_FORMAT_SORT,
    "--print-to-file", metadata_template, str(metadata_path), "-o", "-", page_url,
  ]
  authentication = "configured browser-cookie fallback" if include_cookies else "public-video path"
  log(f"Streaming smallest audio into ffmpeg for {page_url} ({target_bins} peak bins, {authentication})")
  yt_dlp_process = register_process(subprocess.Popen(
    yt_dlp_command,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
  ))
  ffmpeg_process = None
  try:
    metadata = read_stream_metadata(metadata_path, yt_dlp_process)
    duration = metadata["duration"]
    if duration and duration > MAX_DURATION_SECONDS:
      yt_dlp_process.kill()
      raise ValueError("Video is too long for the local waveform helper.")
    if not duration:
      yt_dlp_process.kill()
      raise ValueError("YouTube did not provide a duration for waveform generation.")
    ffmpeg_command = [
      "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ]
    assert yt_dlp_process.stdout is not None
    ffmpeg_process = register_process(subprocess.Popen(
      ffmpeg_command,
      stdin=yt_dlp_process.stdout,
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
    ))
    yt_dlp_process.stdout.close()
    assert ffmpeg_process.stdout is not None
    max_peaks, decoded_duration = decode_pcm_peak_stream(
      ffmpeg_process.stdout,
      duration,
      target_bins,
      progress_callback=progress_callback,
      progress_bins=PREVIEW_WAVEFORM_BINS,
    )
    ffmpeg_stderr = ffmpeg_process.stderr.read().decode("utf-8", errors="replace") if ffmpeg_process.stderr else ""
    ffmpeg_exit = ffmpeg_process.wait()
    yt_dlp_stderr = yt_dlp_process.stderr.read().decode("utf-8", errors="replace") if yt_dlp_process.stderr else ""
    yt_dlp_exit = yt_dlp_process.wait()
    if yt_dlp_exit != 0:
      raise RuntimeError(yt_dlp_stderr.strip() or "yt-dlp failed while streaming audio.")
    if ffmpeg_exit != 0:
      raise RuntimeError(ffmpeg_stderr.strip() or "ffmpeg failed while decoding streamed audio.")
    resolved_duration = decoded_duration if decoded_duration > 0 else duration
    created_at = int(time.time())
    payloads = {}
    for bins in bins_values:
      payloads[bins] = {
        "peaks": max_peaks if bins == target_bins else downsample_peaks(max_peaks, bins),
        "duration": resolved_duration,
        "title": metadata["title"],
        "source": "yt-dlp stdout streamed directly into ffmpeg",
        "sampleRate": SAMPLE_RATE,
        "formatSelector": settings["sourceAudioFormat"],
        "formatSort": DEFAULT_PREFETCH_FORMAT_SORT,
        "formatId": metadata["formatId"],
        "sourceExtension": metadata["extension"],
        "createdAt": created_at,
      }
    return payloads
  finally:
    metadata_path.unlink(missing_ok=True)
    if ffmpeg_process and ffmpeg_process.poll() is None:
      ffmpeg_process.kill()
    if yt_dlp_process.poll() is None:
      yt_dlp_process.kill()
    unregister_process(ffmpeg_process)
    unregister_process(yt_dlp_process)


def is_retryable_youtube_stream_error(error: Exception) -> bool:
  detail = str(error).lower()
  return any(marker in detail for marker in (
    "403", "429", "timed out", "timeout", "connection reset",
    "remote end closed", "temporary failure", "try again",
  ))


def is_youtube_authentication_error(error: Exception) -> bool:
  detail = str(error).lower()
  return any(marker in detail for marker in (
    "sign in to confirm you're not a bot",
    "sign in to confirm you’re not a bot",
    "sign in to confirm you\ufffdre not a bot",
    "login required",
    "authentication required",
  ))


def stream_youtube_waveforms(page_url: str, bins_values: list[int], progress_callback=None) -> dict[int, dict]:
  public_errors: list[RuntimeError] = []
  for attempt in range(len(YOUTUBE_STREAM_RETRY_DELAYS) + 1):
    try:
      return _stream_youtube_waveforms_attempt(
        page_url, bins_values, include_cookies=False, progress_callback=progress_callback
      )
    except RuntimeError as error:
      public_errors.append(error)
      if is_youtube_authentication_error(error):
        break
      if SHUTDOWN_EVENT.is_set() or not is_retryable_youtube_stream_error(error):
        raise
      if attempt < len(YOUTUBE_STREAM_RETRY_DELAYS):
        delay = YOUTUBE_STREAM_RETRY_DELAYS[attempt]
        log(f"Public-video prefetch attempt {attempt + 1} failed; retrying in {delay:g}s: {error}")
        time.sleep(delay)

  public_error = public_errors[-1]
  log(f"Public-video retries failed; trying configured browser cookies: {public_error}")
  try:
    return _stream_youtube_waveforms_attempt(
      page_url, bins_values, include_cookies=True, progress_callback=progress_callback
    )
  except RuntimeError as cookie_error:
    if SHUTDOWN_EVENT.is_set():
      raise
    raise RuntimeError(
      "YouTube rejected the media transfer after anonymous retries and the configured "
      "browser-cookie/PO-token provider fallback. Galaktika's providers are installed, so verify that "
      "the configured cookie source is signed in to YouTube and rerun Install-Galaktika-Helper.cmd. "
      f"Last error: {cookie_error}"
    ) from cookie_error


@contextmanager
def download_workspace(download_dir: Path, staging: bool):
  if not staging:
    yield download_dir
    return
  with tempfile.TemporaryDirectory(prefix="galaktika-march-") as temporary_directory:
    yield Path(temporary_directory)


def download_best_wav(
  page_url: str,
  output_path: str | None = None,
  marker_times: list[float] | None = None,
  staging: bool = False,
) -> dict:
  requested_path = validate_output_path(output_path, ".wav")
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  settings = get_yt_dlp_settings()
  with download_workspace(download_dir, staging) as work_dir:
    output_template = str(work_dir / ".galaktika-%(title).180B.%(ext)s") if requested_path else str(work_dir / "%(title).180B.%(ext)s")
    log(f"Downloading best WAV to: {output_template}")
    before = {path.resolve() for path in work_dir.glob("*.wav")}
    run_text(yt_dlp_common_args(settings) + [
      "-f", settings["bestWavFormat"],
      "--embed-metadata", "--extract-audio", "--audio-format", "wav", "--audio-quality", "0",
      "-o", output_template, page_url,
    ])
    wav_path = newest_created_download(work_dir, ".wav", before)
    marker_count = embed_wav_cue_markers(wav_path, marker_times or [])
    raise_if_request_cancelled()
    wav_path = rename_download(wav_path, requested_path, ".wav", download_dir)
  return {
    "ok": True,
    "path": str(wav_path),
    "filename": wav_path.name,
    "bytes": wav_path.stat().st_size,
    "downloadDir": str(download_dir),
    "markers": marker_count,
    "source": "yt-dlp bestaudio WAV",
  }


def get_original_audio_info(page_url: str) -> dict:
  settings = get_yt_dlp_settings()
  command_tail = [
    "--simulate",
    "--skip-download",
    "--no-warnings",
    "--print",
    "%(title)j\t%(ext)j\t%(format_id)j\t%(acodec)j",
    "-f",
    DEFAULT_ORIGINAL_AUDIO_FORMAT,
    page_url,
  ]
  try:
    output = run_text(yt_dlp_common_args(settings, include_cookies=False) + command_tail)
  except subprocess.CalledProcessError:
    output = run_text(yt_dlp_common_args(settings, include_cookies=True) + command_tail)
  lines = [line for line in output.splitlines() if line.strip()]
  if not lines:
    raise RuntimeError("yt-dlp returned no original-audio format information.")
  parts = lines[-1].split("\t", 3)
  if len(parts) != 4:
    raise RuntimeError("yt-dlp returned incomplete original-audio format information.")
  title, extension, format_id, audio_codec = (json.loads(part) for part in parts)
  safe_extension = normalize_extension(str(extension or "webm"), ".webm")
  safe_title = sanitize_filename_part(str(title or "YouTube original audio"))
  return {
    "ok": True,
    "title": str(title or "YouTube original audio"),
    "extension": safe_extension,
    "formatId": str(format_id or ""),
    "audioCodec": str(audio_codec or "unknown"),
    "suggestedFilename": f"{safe_title}{safe_extension}",
    "source": "yt-dlp original bestaudio selection",
  }


def download_original_audio(page_url: str, output_path: str | None = None, staging: bool = False) -> dict:
  requested_extension = normalize_extension(Path(output_path).suffix if output_path else ".webm", ".webm")
  requested_path = validate_output_path(output_path, requested_extension)
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  settings = get_yt_dlp_settings()
  with download_workspace(download_dir, staging) as work_dir:
    output_template = str(work_dir / ".galaktika-%(title).180B.%(ext)s") if requested_path else str(work_dir / "%(title).180B.%(ext)s")
    before = {path.resolve() for path in work_dir.iterdir() if path.is_file()}
    log(f"Downloading original YouTube audio without transcoding to: {output_template}")
    command_tail = [
      "-f", DEFAULT_ORIGINAL_AUDIO_FORMAT,
      "--embed-metadata", "--print", "after_move:%(filepath)j",
      "-o", output_template, page_url,
    ]
    try:
      output = run_text(yt_dlp_common_args(settings, include_cookies=False) + command_tail)
    except subprocess.CalledProcessError:
      if SHUTDOWN_EVENT.is_set() or request_cancelled():
        raise
      output = run_text(yt_dlp_common_args(settings, include_cookies=True) + command_tail)
    downloaded_path = None
    for line in reversed(output.splitlines()):
      try:
        candidate = Path(json.loads(line)).resolve()
      except (json.JSONDecodeError, TypeError, ValueError):
        continue
      if candidate.exists() and candidate.is_file():
        downloaded_path = candidate
        break
    if downloaded_path is None:
      created = sorted(
        (path for path in work_dir.iterdir() if path.is_file() and path.resolve() not in before),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
      )
      if not created:
        raise FileNotFoundError(f"yt-dlp did not create an original audio file in {work_dir}")
      downloaded_path = created[0]
    raise_if_request_cancelled()
    original_extension = normalize_extension(downloaded_path.suffix, requested_extension)
    final_path = rename_download(downloaded_path, requested_path, original_extension, download_dir)
  return {
    "ok": True,
    "path": str(final_path),
    "filename": final_path.name,
    "extension": final_path.suffix.lower(),
    "bytes": final_path.stat().st_size,
    "downloadDir": str(download_dir),
    "source": "yt-dlp bestaudio without transcoding",
  }


def newest_created_download(download_dir: Path, extension: str, before: set[Path]) -> Path:
  after = sorted(
    (path for path in download_dir.glob(f"*{extension}") if path.resolve() not in before),
    key=lambda path: path.stat().st_mtime,
    reverse=True,
  )
  if not after:
    after = sorted(download_dir.glob(f"*{extension}"), key=lambda path: path.stat().st_mtime, reverse=True)
  if not after:
    raise FileNotFoundError(f"yt-dlp did not create a {extension} file in {download_dir}")
  return after[0]


def rename_download(download_path: Path, requested_path: Path | None, extension: str, download_dir: Path) -> Path:
  raise_if_request_cancelled()
  if requested_path:
    renamed_path = requested_path.with_suffix(extension)
    if renamed_path.exists():
      renamed_path.unlink()
  else:
    title_part = sanitize_filename_part(download_path.stem)
    title_part = re.sub(r"^\.galaktika-", "", title_part)
    renamed_path = unique_path(download_dir / f"{title_part}{extension}")
  if renamed_path != download_path:
    shutil.move(str(download_path), str(renamed_path))
    if request_cancelled():
      renamed_path.unlink(missing_ok=True)
      raise RequestCancelledError("The current MARCH item was skipped.")
    return renamed_path
  return download_path


def download_best_mp3(page_url: str, output_path: str | None = None, staging: bool = False) -> dict:
  requested_path = validate_output_path(output_path, ".mp3")
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  settings = get_yt_dlp_settings()
  with download_workspace(download_dir, staging) as work_dir:
    output_template = str(work_dir / ".galaktika-%(title).180B.%(ext)s") if requested_path else str(work_dir / "%(title).180B.%(ext)s")
    log(f"Downloading MP3 to: {output_template}")
    before = {path.resolve() for path in work_dir.glob("*.mp3")}
    run_text(yt_dlp_common_args(settings) + [
      "-f", DEFAULT_BEST_MP3_FORMAT,
      "--embed-metadata", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
      "-o", output_template, page_url,
    ])
    raise_if_request_cancelled()
    mp3_path = rename_download(newest_created_download(work_dir, ".mp3", before), requested_path, ".mp3", download_dir)
  return {
    "ok": True,
    "path": str(mp3_path),
    "filename": mp3_path.name,
    "bytes": mp3_path.stat().st_size,
    "downloadDir": str(download_dir),
    "source": "yt-dlp bestaudio MP3",
  }


def download_best_mp4(page_url: str, output_path: str | None = None, staging: bool = False) -> dict:
  requested_path = validate_output_path(output_path, ".mp4")
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  settings = get_yt_dlp_settings()
  with download_workspace(download_dir, staging) as work_dir:
    output_template = str(work_dir / ".galaktika-%(title).180B.%(ext)s") if requested_path else str(work_dir / "%(title).180B.%(ext)s")
    log(f"Downloading MP4 to: {output_template}")
    before = {path.resolve() for path in work_dir.glob("*.mp4")}
    run_text(yt_dlp_common_args(settings) + [
      "-f", DEFAULT_MP4_FORMAT,
      "--embed-metadata", "--merge-output-format", "mp4",
      "-o", output_template, page_url,
    ])
    raise_if_request_cancelled()
    mp4_path = rename_download(newest_created_download(work_dir, ".mp4", before), requested_path, ".mp4", download_dir)
  return {
    "ok": True,
    "path": str(mp4_path),
    "filename": mp4_path.name,
    "bytes": mp4_path.stat().st_size,
    "downloadDir": str(download_dir),
    "source": "yt-dlp MP4 video",
  }


def first_packet_timestamp(media_path: Path, stream_selector: str) -> float | None:
  output = run_text([
    "ffprobe",
    "-v", "error",
    "-select_streams", stream_selector,
    "-read_intervals", "%+#1",
    "-show_entries", "packet=pts_time",
    "-of", "csv=p=0",
    str(media_path),
  ])
  first_value = next((line.strip().split(",", 1)[0] for line in output.splitlines() if line.strip()), "")
  if not first_value:
    return None
  try:
    timestamp = float(first_value)
  except ValueError as exc:
    raise RuntimeError(f"Could not parse the first timestamp for stream {stream_selector}: {first_value}") from exc
  return timestamp if math.isfinite(timestamp) else None


def game_ffmpeg_command(source_path: Path, output_path: Path, progress: bool = False) -> list[str]:
  video_start = first_packet_timestamp(source_path, "v:0")
  if video_start is None:
    raise ValueError("The downloaded media does not contain a video stream.")
  audio_start = first_packet_timestamp(source_path, "a:0")
  has_audio = audio_start is not None
  timeline_start = min(video_start, audio_start) if has_audio else video_start
  video_lead_in = max(0.0, video_start - timeline_start)
  audio_lead_in = max(0.0, audio_start - timeline_start) if has_audio else 0.0

  video_filters = ["setpts=PTS-STARTPTS"]
  if video_lead_in > 0.000001:
    video_filters.append(f"tpad=start_mode=add:start_duration={video_lead_in:.6f}:color=black")
  video_filters.extend([
    f"fps=fps={GAME_FPS}:round=near",
    f"scale=-2:{GAME_HEIGHT}:flags=area",
  ])

  command = [
    "ffmpeg", "-hide_banner", "-nostats" if progress else "-stats", "-n", "-i", str(source_path),
    "-map", "0:v:0", "-vf", ",".join(video_filters),
    "-c:v", "libx264", "-preset", "slow", "-crf", str(GAME_CRF),
    "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
    "-g", str(GAME_FPS * 2), "-keyint_min", str(GAME_FPS), "-sn", "-dn",
  ]
  if has_audio:
    audio_filters = ["asetpts=PTS-STARTPTS"]
    if audio_lead_in > 0.000001:
      audio_filters.append(f"adelay=delays={round(audio_lead_in * 1000)}:all=1")
    audio_filters.append("aresample=48000:async=1:first_pts=0")
    command.extend([
      "-map", "0:a:0", "-af", ",".join(audio_filters),
      "-c:a", "aac", "-b:a", GAME_AUDIO_BITRATE, "-ac", "2", "-ar", "48000", "-shortest",
    ])
  else:
    command.append("-an")
  if progress:
    command.extend(["-progress", "pipe:1"])
  command.extend(["-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", str(output_path)])
  return command


def download_game_video(page_url: str, output_path: str | None = None, progress_callback=None, staging: bool = False) -> dict:
  requested_path = validate_output_path(output_path, ".mp4")
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  settings = get_yt_dlp_settings()
  log("Downloading source video for GAME conversion.")

  with tempfile.TemporaryDirectory(prefix="galaktika-game-") as temporary_directory:
    temporary_dir = Path(temporary_directory)
    source_template = str(temporary_dir / "source.%(ext)s")
    command_tail = [
      "-f", DEFAULT_MP4_FORMAT,
      "--merge-output-format", "mp4",
      "--newline",
      "--progress",
      "--progress-template", "download:GAME-DOWNLOAD:%(progress._percent_str)s",
      "--print", "before_dl:GALAKTIKA-TITLE:%(title)j",
      "--print", "after_move:%(filepath)j",
      "-o", source_template,
      page_url,
    ]
    def report_download(line: str) -> None:
      match = re.search(r"GAME-DOWNLOAD:\s*([0-9]+(?:\.[0-9]+)?)%", line)
      if match and progress_callback:
        progress_callback({"phase": "download", "percent": min(100.0, float(match.group(1)))})

    if progress_callback:
      progress_callback({"phase": "download", "percent": 0})
    try:
      output = run_streaming_capture(
        yt_dlp_common_args(settings, include_cookies=False) + command_tail,
        stdout_callback=report_download,
      ).stdout.strip()
    except subprocess.CalledProcessError:
      if SHUTDOWN_EVENT.is_set():
        raise
      output = run_streaming_capture(
        yt_dlp_common_args(settings, include_cookies=True) + command_tail,
        stdout_callback=report_download,
      ).stdout.strip()

    source_path = None
    for line in reversed(output.splitlines()):
      try:
        candidate = Path(json.loads(line)).resolve()
      except (json.JSONDecodeError, TypeError, ValueError):
        continue
      if candidate.exists() and candidate.is_file():
        source_path = candidate
        break
    if source_path is None:
      candidates = sorted(temporary_dir.glob("source.*"), key=lambda path: path.stat().st_mtime, reverse=True)
      if not candidates:
        raise FileNotFoundError("yt-dlp did not create a source video for GAME conversion.")
      source_path = candidates[0]

    converted_path = temporary_dir / "game.mp4"
    log(f"Converting GAME video to: {requested_path or download_dir}")
    duration = probe_duration(source_path) or 0.0

    def report_conversion(line: str) -> None:
      if not progress_callback or duration <= 0:
        return
      match = re.fullmatch(r"out_time_(?:us|ms)=([0-9]+)", line)
      if match:
        elapsed_seconds = int(match.group(1)) / 1_000_000
        progress_callback({"phase": "convert", "percent": min(99.0, (elapsed_seconds / duration) * 100)})
      elif line == "progress=end":
        progress_callback({"phase": "convert", "percent": 100})

    if progress_callback:
      progress_callback({"phase": "download", "percent": 100})
      progress_callback({"phase": "convert", "percent": 0})
    run_streaming_capture(
      game_ffmpeg_command(source_path, converted_path, progress=True),
      stdout_callback=report_conversion,
    )
    if not converted_path.is_file():
      raise FileNotFoundError("ffmpeg did not create the GAME MP4 file.")

    raise_if_request_cancelled()
    title_abbreviation = abbreviate_video_title(printed_video_title(output, "GALAKTIKA-TITLE:"))
    if requested_path:
      final_path = requested_path.with_suffix(".mp4")
      if final_path.exists():
        final_path.unlink()
    else:
      final_path = unique_path(download_dir / f"{title_abbreviation}.mp4")
    shutil.move(str(converted_path), str(final_path))
    if request_cancelled():
      final_path.unlink(missing_ok=True)
      raise RequestCancelledError("The current MARCH item was skipped.")

  return {
    "ok": True,
    "path": str(final_path),
    "filename": final_path.name,
    "bytes": final_path.stat().st_size,
    "downloadDir": str(download_dir),
    "source": "yt-dlp video converted to GAME MP4",
    "profile": {
      "fps": GAME_FPS,
      "height": GAME_HEIGHT,
      "crf": GAME_CRF,
      "audioBitrate": GAME_AUDIO_BITRATE,
    },
  }


def unity_aac_ffmpeg_command(
  source_path: Path,
  output_path: Path,
  progress: bool = False,
  bitrate_bps: int | None = None,
) -> list[str]:
  audio_start = first_packet_timestamp(source_path, "a:0")
  if audio_start is None:
    raise ValueError("The downloaded media does not contain an audio stream.")
  source_bitrate = bitrate_bps if bitrate_bps is not None else probe_audio_bitrate(source_path)
  if source_bitrate <= 0:
    raise ValueError("The source audio bitrate must be greater than zero.")
  command = [
    "ffmpeg", "-hide_banner", "-nostats" if progress else "-stats", "-n", "-i", str(source_path),
    "-map", "0:a:0",
    "-af", f"asetpts=PTS-STARTPTS,aresample={UNITY_AAC_SAMPLE_RATE}:async=1:first_pts=0",
    "-c:a", "aac", "-b:a", str(source_bitrate), "-ac", "2", "-ar", str(UNITY_AAC_SAMPLE_RATE),
    "-vn", "-sn", "-dn",
  ]
  if progress:
    command.extend(["-progress", "pipe:1"])
  command.extend(["-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", str(output_path)])
  return command


def download_unity_aac(page_url: str, output_path: str | None = None, progress_callback=None, staging: bool = False) -> dict:
  requested_path = validate_output_path(output_path, ".m4a")
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  settings = get_yt_dlp_settings()
  log("Downloading source audio for Unity AAC conversion.")

  with tempfile.TemporaryDirectory(prefix="galaktika-aac-") as temporary_directory:
    temporary_dir = Path(temporary_directory)
    source_template = str(temporary_dir / "source.%(ext)s")
    command_tail = [
      "-f", DEFAULT_ORIGINAL_AUDIO_FORMAT,
      "--newline",
      "--progress",
      "--progress-template", "download:UNITY-AAC-DOWNLOAD:%(progress._percent_str)s",
      "--print", "before_dl:GALAKTIKA-TITLE:%(title)j",
      "--print", "after_move:%(filepath)j",
      "-o", source_template,
      page_url,
    ]

    def report_download(line: str) -> None:
      match = re.search(r"UNITY-AAC-DOWNLOAD:\s*([0-9]+(?:\.[0-9]+)?)%", line)
      if match and progress_callback:
        progress_callback({"phase": "download", "percent": min(100.0, float(match.group(1)))})

    if progress_callback:
      progress_callback({"phase": "download", "percent": 0})
    try:
      output = run_streaming_capture(
        yt_dlp_common_args(settings, include_cookies=False) + command_tail,
        stdout_callback=report_download,
      ).stdout.strip()
    except subprocess.CalledProcessError:
      if SHUTDOWN_EVENT.is_set():
        raise
      output = run_streaming_capture(
        yt_dlp_common_args(settings, include_cookies=True) + command_tail,
        stdout_callback=report_download,
      ).stdout.strip()

    source_path = None
    for line in reversed(output.splitlines()):
      try:
        candidate = Path(json.loads(line)).resolve()
      except (json.JSONDecodeError, TypeError, ValueError):
        continue
      if candidate.exists() and candidate.is_file():
        source_path = candidate
        break
    if source_path is None:
      candidates = sorted(temporary_dir.glob("source.*"), key=lambda path: path.stat().st_mtime, reverse=True)
      if not candidates:
        raise FileNotFoundError("yt-dlp did not create source audio for Unity AAC conversion.")
      source_path = candidates[0]

    converted_path = temporary_dir / "unity.m4a"
    source_bitrate = probe_audio_bitrate(source_path)
    log(f"Converting Unity AAC audio at the source bitrate ({source_bitrate / 1000:.2f} kbps) to: {requested_path or download_dir}")
    duration = probe_duration(source_path) or 0.0

    def report_conversion(line: str) -> None:
      if not progress_callback or duration <= 0:
        return
      match = re.fullmatch(r"out_time_(?:us|ms)=([0-9]+)", line)
      if match:
        elapsed_seconds = int(match.group(1)) / 1_000_000
        progress_callback({"phase": "convert", "percent": min(99.0, (elapsed_seconds / duration) * 100)})
      elif line == "progress=end":
        progress_callback({"phase": "convert", "percent": 100})

    if progress_callback:
      progress_callback({"phase": "download", "percent": 100})
      progress_callback({"phase": "convert", "percent": 0})
    run_streaming_capture(
      unity_aac_ffmpeg_command(source_path, converted_path, progress=True, bitrate_bps=source_bitrate),
      stdout_callback=report_conversion,
    )
    if not converted_path.is_file():
      raise FileNotFoundError("ffmpeg did not create the Unity AAC file.")

    raise_if_request_cancelled()
    title_abbreviation = abbreviate_video_title(printed_video_title(output, "GALAKTIKA-TITLE:"))
    if requested_path:
      final_path = requested_path.with_suffix(".m4a")
      if final_path.exists():
        final_path.unlink()
    else:
      final_path = unique_path(download_dir / f"{title_abbreviation}.m4a")
    shutil.move(str(converted_path), str(final_path))
    if request_cancelled():
      final_path.unlink(missing_ok=True)
      raise RequestCancelledError("The current MARCH item was skipped.")

  return {
    "ok": True,
    "path": str(final_path),
    "filename": final_path.name,
    "bytes": final_path.stat().st_size,
    "downloadDir": str(download_dir),
    "source": "yt-dlp bestaudio converted to Unity AAC",
    "profile": {
      "codec": "aac",
      "container": "m4a",
      "sampleRate": UNITY_AAC_SAMPLE_RATE,
      "bitrate": source_bitrate,
      "bitrateKbps": round(source_bitrate / 1000, 2),
      "channels": 2,
    },
  }


def media_extension_from_url(media_url: str, fallback: str = ".mp3") -> str:
  suffix = Path(urlparse(media_url).path).suffix.lower()
  return suffix if suffix in DIRECT_MEDIA_EXTENSIONS else fallback


def parse_direct_metadata(title: str | None, media_url: str) -> dict:
  metadata = {
    "title": title or Path(urlparse(media_url).path).stem or "Radiooooo track",
    "artist": None,
    "album": None,
    "year": None,
    "country": None,
  }
  if isinstance(title, str) and "||" in title:
    parts = [part.strip() for part in title.split("||")]
    metadata["title"] = parts[0] or metadata["title"]
    metadata["artist"] = parts[1] if len(parts) > 1 and parts[1] else None
    metadata["album"] = parts[2] if len(parts) > 2 and parts[2] else None
    metadata["year"] = parts[3] if len(parts) > 3 and parts[3] else None
    metadata["country"] = parts[4] if len(parts) > 4 and parts[4] else None
  return metadata


def download_direct_media_to_cache(media_url: str) -> tuple[Path, float | None, str | None]:
  AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
  cleanup_audio_cache(STALE_AUDIO_CACHE_SECONDS)
  base = direct_audio_cache_base(media_url)
  existing_matches = sorted(AUDIO_CACHE_DIR.glob(f"{base.name}.*"), key=lambda path: path.stat().st_mtime, reverse=True)
  if existing_matches:
    existing = existing_matches[0]
    return existing, probe_duration(existing), existing.stem

  output_path = base.with_suffix(media_extension_from_url(media_url))
  request = urllib.request.Request(media_url, headers={"User-Agent": "Mozilla/5.0"})
  log(f"Downloading direct media to: {output_path}")
  with urllib.request.urlopen(request, timeout=120) as response, output_path.open("wb") as file:
    while True:
      chunk = response.read(1024 * 1024)
      if not chunk:
        break
      file.write(chunk)

  duration = probe_duration(output_path)
  if duration and duration > MAX_DURATION_SECONDS:
    try:
      output_path.unlink()
    except OSError:
      pass
    raise ValueError("Media is too long for the local waveform helper.")
  return output_path, duration, output_path.stem


def build_direct_waveform(media_url: str, bins: int, title: str | None = None) -> dict:
  CACHE_DIR.mkdir(exist_ok=True)
  cleanup_waveform_json_cache()
  cached = direct_media_cache_key(media_url, bins)
  if cached.exists():
    if bins > PREVIEW_AUDIO_REUSE_MAX_BINS:
      cleanup_redundant_preview_cache(cached, direct_media_cache_key(media_url, PREVIEW_WAVEFORM_BINS))
    return json.loads(cached.read_text(encoding="utf-8"))

  audio_path, duration, fallback_title = download_direct_media_to_cache(media_url)
  metadata = parse_direct_metadata(title or fallback_title, media_url)
  try:
    payload = {
      "peaks": decode_waveform(audio_path, duration, bins),
      "duration": duration,
      "title": sanitize_filename_part(metadata["title"] or "Radiooooo track"),
      "artist": metadata["artist"],
      "album": metadata["album"],
      "year": metadata["year"],
      "country": metadata["country"],
      "source": "direct media URL + ffmpeg",
      "sampleRate": SAMPLE_RATE,
      "createdAt": int(time.time()),
    }
    cached.write_text(json.dumps(payload), encoding="utf-8")
    if bins > PREVIEW_AUDIO_REUSE_MAX_BINS:
      cleanup_redundant_preview_cache(cached, direct_media_cache_key(media_url, PREVIEW_WAVEFORM_BINS))
    cleanup_waveform_json_cache()
    return payload
  finally:
    keep_for_refinement = bins <= PREVIEW_AUDIO_REUSE_MAX_BINS
    if not keep_for_refinement:
      try:
        if audio_path.exists():
          audio_path.unlink()
      except OSError as exc:
        log(f"Could not delete temporary audio file {audio_path}: {exc}")


def download_direct_media(media_url: str, title: str | None = None, output_path: str | None = None) -> dict:
  extension = media_extension_from_url(media_url)
  requested_path = validate_output_path(output_path, extension)
  download_dir = requested_path.parent if requested_path else get_download_dir()
  download_dir.mkdir(parents=True, exist_ok=True)
  metadata = parse_direct_metadata(title, media_url)
  display_title = metadata["title"]
  artist = metadata["artist"]
  album = metadata["album"]
  year = metadata["year"]
  country = metadata["country"]
  filename = sanitize_filename_part(" - ".join(part for part in (artist, display_title) if part) or display_title)
  output_file = requested_path.with_suffix(extension) if requested_path else unique_path(download_dir / f"{filename}{extension}")
  temp_path = unique_path(output_file.with_name(f".galaktika-{output_file.stem}{output_file.suffix}"))
  request = urllib.request.Request(media_url, headers={"User-Agent": "Mozilla/5.0"})
  log(f"Downloading direct media to: {output_file}")
  with urllib.request.urlopen(request, timeout=120) as response, temp_path.open("wb") as file:
    while True:
      chunk = response.read(1024 * 1024)
      if not chunk:
        break
      file.write(chunk)

  metadata_command = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    str(temp_path),
    "-map",
    "0",
    "-c",
    "copy",
    "-metadata",
    f"title={display_title}",
  ]
  if artist:
    metadata_command.extend(["-metadata", f"artist={artist}"])
  if album:
    metadata_command.extend(["-metadata", f"album={album}"])
  if year:
    metadata_command.extend(["-metadata", f"date={year}"])
  if country:
    metadata_command.extend(["-metadata", f"grouping={country}"])
  metadata_command.extend(["-metadata", "comment=Downloaded from Radiooooo with Gidaeon's Galaktika", str(output_file)])
  try:
    run_text(metadata_command)
    temp_path.unlink(missing_ok=True)
  except Exception as exc:
    log(f"Could not embed metadata with ffmpeg, keeping direct file: {exc}")
    if output_file.exists():
      output_file.unlink()
    temp_path.rename(output_file)
  return {
    "ok": True,
    "path": str(output_file),
    "filename": output_file.name,
    "bytes": output_file.stat().st_size,
    "downloadDir": str(download_dir),
    "source": "direct media URL",
  }


def decode_waveform(audio_path: Path, duration: float | None, bins: int) -> list[float]:
  command = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    str(audio_path),
    "-vn",
    "-ac",
    "1",
    "-ar",
    str(SAMPLE_RATE),
    "-f",
    "s16le",
    "pipe:1",
  ]

  process = register_process(subprocess.Popen(
    command,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
  ))
  assert process.stdout is not None

  peaks = [0.0 for _ in range(bins)]
  samples_per_bin = max(1, math.ceil(((duration or 1) * SAMPLE_RATE) / bins))
  sample_index = 0
  bin_index = 0

  while True:
    chunk = process.stdout.read(64 * 1024)
    if not chunk:
      break
    samples = array("h")
    samples.frombytes(chunk[: len(chunk) - (len(chunk) % 2)])
    if sys.byteorder != "little":
      samples.byteswap()

    for sample in samples:
      if bin_index >= bins:
        break
      amplitude = abs(sample) / 32768
      if amplitude > peaks[bin_index]:
        peaks[bin_index] = amplitude
      sample_index += 1
      bin_index = min(bins - 1, sample_index // samples_per_bin)

  try:
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    exit_code = process.wait()
    if exit_code != 0:
      raise RuntimeError(stderr.strip() or "ffmpeg failed while decoding audio")
  finally:
    unregister_process(process)

  maximum = max(peaks) or 1
  return [round(value / maximum, 4) for value in peaks]


def build_waveform(page_url: str, bins: int, progress_callback=None) -> dict:
  CACHE_DIR.mkdir(exist_ok=True)
  cleanup_waveform_json_cache()
  cached = cache_key(page_url, bins)
  if cached.exists():
    return json.loads(cached.read_text(encoding="utf-8"))

  with waveform_build_lock(page_url):
    if cached.exists():
      return json.loads(cached.read_text(encoding="utf-8"))

    bins_values = sorted(set([bins, PREVIEW_WAVEFORM_BINS, HIGH_RES_WAVEFORM_BINS]))
    payloads = stream_youtube_waveforms(page_url, bins_values, progress_callback=progress_callback)
    for payload_bins, payload in payloads.items():
      payload_cache = cache_key(page_url, payload_bins)
      payload_cache.write_text(json.dumps(payload), encoding="utf-8")
      log(f"Cached streamed waveform: {payload_cache}")
    cleanup_waveform_json_cache()
    return payloads[bins]


def main() -> None:
  raise SystemExit("Galaktika runs through browser native messaging. Run Install-Galaktika-Helper.cmd, then open Galaktika in a supported browser.")


if __name__ == "__main__":
  main()
