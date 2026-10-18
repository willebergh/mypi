#!/usr/bin/env python3
"""Convert the original Pi Talk audio artwork into a macOS ICNS asset."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: build_pi_talk_icon.py OUTPUT.icns")
    if not shutil.which("sips") or not shutil.which("iconutil"):
        raise SystemExit("sips and iconutil are required (included with macOS)")

    repository = Path(__file__).resolve().parent.parent
    source = repository / "BlackHole" / "PiTalkAudioIcon.png"
    output = Path(sys.argv[1]).resolve()
    if not source.is_file():
        raise SystemExit(f"source artwork not found: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as temporary_directory:
        temporary = Path(temporary_directory)
        base = temporary / "base.png"
        iconset = temporary / "PiTalkAudio.iconset"
        iconset.mkdir()

        subprocess.run(
            ["sips", "-z", "1024", "1024", str(source), "--out", str(base)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        variants = {
            "icon_16x16.png": 16,
            "icon_16x16@2x.png": 32,
            "icon_32x32.png": 32,
            "icon_32x32@2x.png": 64,
            "icon_128x128.png": 128,
            "icon_128x128@2x.png": 256,
            "icon_256x256.png": 256,
            "icon_256x256@2x.png": 512,
            "icon_512x512.png": 512,
            "icon_512x512@2x.png": 1024,
        }
        for filename, size in variants.items():
            subprocess.run(
                ["sips", "-z", str(size), str(size), str(base), "--out", str(iconset / filename)],
                check=True,
                stdout=subprocess.DEVNULL,
            )

        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(output)], check=True)


if __name__ == "__main__":
    main()
