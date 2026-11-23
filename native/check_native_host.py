#!/usr/bin/env python3
"""Installer smoke test for Galaktika's framed native messaging transport."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path


def main() -> None:
  launcher = Path(sys.argv[1]).resolve()
  request = json.dumps({
    "requestId": "installer-health",
    "action": "health",
    "params": {},
  }, separators=(",", ":")).encode("utf-8")
  completed = subprocess.run(
    [str(launcher)],
    input=struct.pack("<I", len(request)) + request,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    timeout=20,
    check=False,
  )
  if completed.returncode != 0:
    raise RuntimeError(completed.stderr.decode("utf-8", errors="replace") or f"Launcher exited with code {completed.returncode}.")
  if len(completed.stdout) < 4:
    raise RuntimeError("Native host returned no framed response.")
  message_length = struct.unpack("<I", completed.stdout[:4])[0]
  message = completed.stdout[4:4 + message_length]
  if len(message) != message_length:
    raise RuntimeError("Native host returned an incomplete framed response.")
  payload = json.loads(message.decode("utf-8"))
  print(json.dumps(payload, separators=(",", ":")))


if __name__ == "__main__":
  main()
