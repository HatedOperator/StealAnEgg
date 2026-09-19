"""FastAPI app: verification endpoints, capture ingest, spawns/predict views.

Run:  uvicorn api.main:app --host 127.0.0.1 --port 8720
"""
from __future__ import annotations

import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from common.banner import Spawn, parse_banners
from common.config import load_config
from common.predictor import next_reset, odds_text
from .db import connect, get_setting
from . import service

CFG = load_config()
CONN = connect(CFG.get("database_path", "eggwatch.db"))

app = FastAPI(title="eggwatch", version="0.1")


# ---------------------------------------------------------------- models ----

class CaptureIn(BaseModel):
    egg: str
    rarity: str
    biome: str
    server_id: str | None = None
    source: str = "scanner"
    spotter: str | None = None


class VerifyStart(BaseModel):
    discord_id: str
    roblox_username: str


# --------------------------------------------------------------- verify -----

@app.post("/api/verify/start")
def verify_start(body: VerifyStart):
    code = service.create_code(CONN, body.discord_id, body.roblox_username.strip())
    return {"code": code, "instructions": CODE_INSTRUCTIONS.format(code=code)}


@app.get("/api/verify/check/{discord_id}")
async def verify_check(discord_id: str):
    try:
        link = await service.check_code(CONN, CFG, discord_id)
    except service.VerificationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"verified": True, **link}


CODE_INSTRUCTIONS = (
    "1. Go to roblox.com and log in as your account.\n"
    "2. Settings → About → paste this code into your profile blurb:\n"
    "   **{code}**\n"
    "3. Save, then run the check. You can delete it right after verifying."
)


# -------------------------------------------------------------- captures ----

@app.post("/api/capture")
def capture(body: CaptureIn):
    spawn = Spawn(egg=body.egg, rarity=body.rarity, biome=body.biome)
    row_id = service.ingest_spawn(
        CONN, CFG, spawn,
        server_id=body.server_id, source=body.source, spotter=body.spotter,
    )
    if row_id is None:
        return {"status": "duplicate"}
    return {"status": "stored", "id": row_id}


@app.post("/api/capture/text")
def capture_text(text: str = ""):
    """Convenience: paste raw OCR text, we parse every banner out of it."""
    spawns = parse_banners(text)
    results = []
    for s in spawns:
        row_id = service.ingest_spawn(
            CONN, CFG, s, server_id=None, source="text", spotter=None
        )
        results.append({"spawn": s.pretty, "status": "stored" if row_id else "duplicate"})
    return {"found": len(spawns), "results": results}


@app.get("/api/spawns")
def spawns(limit: int = 25):
    rows = CONN.execute(
        "SELECT * FROM captures ORDER BY id DESC LIMIT ?", (min(limit, 100),)
    ).fetchall()
    return [dict(r) for r in rows]


# -------------------------------------------------------------- predict -----

@app.get("/api/predict")
def predict():
    epoch_raw = get_setting(CONN, "cycle_epoch")
    epoch = float(epoch_raw) if epoch_raw else None
    p = next_reset(epoch=epoch, cycle_seconds=CFG.get("cycle_seconds", 300))
    return {
        "next_reset_in": p.next_reset_in,
        "countdown": p.countdown(),
        "cycle_number": p.cycle_number,
        "anchored": p.anchored,
        "odds": CFG.get("cycle_odds", {}),
    }


@app.get("/api/leaderboard")
def leaderboard(limit: int = 10):
    rows = CONN.execute(
        "SELECT spotter, COUNT(*) AS catches FROM captures"
        " WHERE spotter IS NOT NULL GROUP BY spotter"
        " ORDER BY catches DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/health")
def health():
    return {"ok": True, "ts": time.time()}
