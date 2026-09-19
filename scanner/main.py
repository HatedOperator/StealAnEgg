"""eggwatch scanner — the member-side sensor.

Reads YOUR OWN screen while you play:
- finds the Roblox window (title contains "Roblox")
- grabs the top-center strip where spawn banners appear
- OCRs it, parses "A <Rarity> <Egg> Egg spawned in <Biome>!"
- resolves the current server's jobId from the client's launch arguments
  (passive read of the process command line — no injection, no client edits)
- POSTs the capture to the eggwatch API

Run:  python -m scanner.main     (config.json needs api_url + roblox_username)
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from common.banner import parse_banners  # noqa: E402
from common.config import load_config  # noqa: E402
from common import ocr  # noqa: E402

CFG = load_config()
ocr.configure(CFG)

POLL_SECONDS = 2.0
REPEAT_SUPPRESS_SECONDS = 60  # same banner text seen again within this window is skipped

_last_by_text: dict[str, float] = {}


# ------------------------------------------------------------- window -------

def find_roblox_window():
    """Return (left, top, width, height) of the Roblox window, or None."""
    import pygetwindow as gw
    wins = [w for w in gw.getAllWindows() if "roblox" in (w.title or "").lower()]
    if not wins:
        return None
    w = wins[0]
    if w.width < 200 or w.height < 150:  # minimized
        return None
    return w.left, w.top, w.width, w.height


def banner_region(box):
    """Spawn banners show top-center; capture the top ~18% of the window."""
    left, top, width, height = box
    pad = int(width * 0.10)
    return {"left": left + pad, "top": top + int(height * 0.03),
            "width": width - 2 * pad, "height": int(height * 0.15)}


def grab_region(region) -> "Image.Image":
    import mss
    from PIL import Image
    with mss.mss() as sct:
        shot = sct.grab(region)
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


# --------------------------------------------------------- server id --------

def current_server_job_id() -> str | None:
    """Read --gameInstanceId from the running client's command line.

    Purely passive: we ask the OS for the process args, same as Task Manager.
    """
    import psutil
    for proc in psutil.process_iter(["name", "cmdline"]):
        try:
            name = (proc.info["name"] or "").lower()
            if "robloxplayer" not in name:
                continue
            args = proc.info["cmdline"] or []
            for i, a in enumerate(args):
                if a == "--gameInstanceId" and i + 1 < len(args):
                    return args[i + 1]
                if a.startswith("--gameInstanceId="):
                    return a.split("=", 1)[1]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


# -------------------------------------------------------------- loop --------

def report(client: httpx.Client, spawn, server_id: str | None):
    payload = {
        "egg": spawn.egg, "rarity": spawn.rarity, "biome": spawn.biome,
        "server_id": server_id, "source": "client",
        "spotter": CFG.get("roblox_username") or None,
    }
    r = client.post(f"{CFG['api_url']}/api/capture", json=payload)
    print(f"[report] {spawn.pretty} -> {r.status_code} {r.text[:80]}")


def main():
    if not CFG.get("api_url"):
        raise SystemExit("Set api_url in config.json")
    print("[scanner] watching for Roblox window... (play the game; this reads your screen)")
    with httpx.Client(timeout=10) as client:
        while True:
            box = find_roblox_window()
            if box is None:
                time.sleep(3)
                continue
            try:
                img = grab_region(banner_region(box))
                text = ocr.image_to_text(img)
            except Exception as e:
                print(f"[scanner] capture/ocr error: {e}")
                time.sleep(POLL_SECONDS)
                continue

            for spawn in parse_banners(text):
                key = spawn.pretty.lower()
                now = time.time()
                if now - _last_by_text.get(key, 0) < REPEAT_SUPPRESS_SECONDS:
                    continue  # banner lingers on screen; only report once
                _last_by_text[key] = now
                server_id = current_server_job_id()
                report(client, spawn, server_id)

            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
