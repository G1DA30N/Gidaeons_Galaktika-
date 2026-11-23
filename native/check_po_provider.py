"""Warm and verify bgutil using the same permissions as yt-dlp, without cookies."""
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parent / ".bgutil-provider" / "server"
home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or str(Path.home())
cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path(home) / ".cache"))) / "bgutil-ytdlp-pot-provider"
modules = root / "node_modules"
command = [sys.argv[1], "run", "--no-prompt", "--allow-env", "--allow-net",
           f"--allow-ffi={modules}", f"--allow-write={cache}",
           f"--allow-read={cache},{modules}", str(root / "src" / "generate_once.ts"), "--version"]
for timeout in (120, 15):
  start = time.monotonic()
  result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=timeout, check=True)
  if result.stdout.strip() != "2.0.0":
    raise RuntimeError("Unexpected bgutil provider version")
  print(f"bgutil {result.stdout.strip()}: {time.monotonic() - start:.2f}s (limit {timeout}s)")
