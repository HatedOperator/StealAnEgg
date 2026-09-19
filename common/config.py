"""Config loader shared by every component.

Precedence: environment variable (EGW_<KEY>) > config.json > defaults.
On Railway/hosts you configure entirely via env vars so config.json (with
secrets) never leaves your machine. Dict/int values are passed as JSON strings.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DEFAULTS: dict[str, Any] = {
    # -- Discord --
    "bot_token": "",
    "guild_id": 0,
    "verified_role_id": 0,
    "screenshot_channel_id": 0,   # screenshots posted here get OCR'd automatically
    "notify_webhook_url": "",     # spawn pings are fanned out through this webhook
    # -- Game --
    "place_id": 0,                # Steal an Egg place id (from the game URL)
    # -- API --
    "api_host": "127.0.0.1",
    "api_port": 8720,
    "database_path": "eggwatch.db",
    # -- Pings --
    "min_rarity_to_ping": "Eternal",
    # rarity (lowercase) -> discord role id to ping
    "ping_roles": {"eternal": 0, "divine": 0, "cosmic": 0, "secret": 0},
    # -- Predictor (odds per 5-min cycle, per server) --
    "cycle_seconds": 300,
    "cycle_odds": {
        "mythic": 0.20,
        "secret": 0.01,
        "eternal": 0.003,
        "divine": 0.001,
        "cosmic": 0.0002,
    },
    # -- OCR --
    "tesseract_cmd": "",          # e.g. "C:/Program Files/Tesseract-OCR/tesseract.exe"
    # -- Scanner --
    "api_url": "http://127.0.0.1:8720",
    "roblox_username": "",        # used to credit reports from this machine
}


def load_config(path: str | Path = "config.json") -> dict[str, Any]:
    cfg = dict(DEFAULTS)
    p = Path(path)
    if p.exists():
        with p.open(encoding="utf-8") as f:
            cfg.update(json.load(f))
    for key in list(cfg):
        env = os.environ.get(f"EGW_{key.upper()}")
        if env is None:
            continue
        if isinstance(cfg[key], bool):
            cfg[key] = env.lower() in ("1", "true", "yes")
        elif isinstance(cfg[key], (int, float)) and not isinstance(cfg[key], bool):
            try:
                cfg[key] = type(cfg[key])(env)
            except ValueError:
                pass
        elif isinstance(cfg[key], dict):
            try:
                cfg[key] = json.loads(env)
            except json.JSONDecodeError:
                pass
        else:
            cfg[key] = env
    return cfg
