"""Business logic shared by the HTTP API and the Discord bot:
   - verification codes + account linking
   - capture ingest (dedupe) + Discord webhook fan-out
"""
from __future__ import annotations

import secrets
import time

import httpx

from .db import connect, get_setting, insert_capture, set_setting
from common.banner import Spawn, rarity_at_least

CODE_PREFIX = "EGG"
CODE_TTL_SECONDS = 30 * 60


class VerificationError(Exception):
    pass


# ---------------------------------------------------------------- verify ----

def create_code(conn, discord_id: str, roblox_username: str) -> str:
    code = f"{CODE_PREFIX}-{secrets.token_hex(2).upper()}"  # EGG-7F3K
    conn.execute(
        "INSERT INTO codes(code, discord_id, roblox_username, created_at, status)"
        " VALUES(?,?,?,?,'pending')"
        " ON CONFLICT(code) DO NOTHING",
        (code, discord_id, roblox_username, time.time()),
    )
    # one pending code per discord user
    conn.execute(
        "UPDATE codes SET status='superseded'"
        " WHERE discord_id=? AND status='pending' AND code!=?",
        (discord_id, code),
    )
    conn.commit()
    return code


async def check_code(conn, cfg: dict, discord_id: str) -> dict:
    """Fetch the Roblox About blurb and look for this user's pending code."""
    row = conn.execute(
        "SELECT * FROM codes WHERE discord_id=? AND status='pending'",
        (discord_id,),
    ).fetchone()
    if row is None:
        raise VerificationError("No pending code. Run /verify first.")
    if time.time() - row["created_at"] > CODE_TTL_SECONDS:
        raise VerificationError("Code expired — run /verify again for a fresh one.")

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        from . import roblox
        user_id, about = await roblox.fetch_about_text(client, row["roblox_username"])

    if row["code"] not in about:
        raise VerificationError(
            f"Couldn't find code `{row['code']}` in {row['roblox_username']}'s About. "
            "Save it at roblox.com → Settings → About, then try again."
        )

    conn.execute(
        "INSERT INTO links(discord_id, roblox_user_id, roblox_username, verified_at)"
        " VALUES(?,?,?,?)"
        " ON CONFLICT(discord_id) DO UPDATE SET"
        "   roblox_user_id=excluded.roblox_user_id,"
        "   roblox_username=excluded.roblox_username,"
        "   verified_at=excluded.verified_at",
        (discord_id, user_id, row["roblox_username"], time.time()),
    )
    conn.execute("UPDATE codes SET status='used' WHERE code=?", (row["code"],))
    conn.commit()
    return {"roblox_user_id": user_id, "roblox_username": row["roblox_username"]}


def get_link(conn, discord_id: str):
    return conn.execute(
        "SELECT * FROM links WHERE discord_id=?", (discord_id,)
    ).fetchone()


# ---------------------------------------------------------------- ingest ----

def ingest_spawn(conn, cfg: dict, spawn: Spawn, *, server_id: str | None,
                 source: str, spotter: str | None) -> int | None:
    """Store a capture (deduped) and fan it out if it clears the ping bar."""
    row_id = insert_capture(
        conn,
        egg=spawn.egg, rarity=spawn.rarity, biome=spawn.biome,
        server_id=server_id, source=source, spotter=spotter,
        cycle_seconds=cfg.get("cycle_seconds", 300),
    )
    if row_id is None:
        return None  # duplicate — already pinged

    # anchor the cycle grid the first time we see real data
    if get_setting(conn, "cycle_epoch") is None:
        set_setting(conn, "cycle_epoch",
                    str(time.time() - (time.time() % cfg.get("cycle_seconds", 300))))

    if rarity_at_least(spawn.rarity, cfg.get("min_rarity_to_ping", "Eternal")):
        try:
            fan_out(cfg, spawn, server_id, spotter, source)
        except Exception as e:  # webhook failure shouldn't lose the capture
            print(f"[fanout] failed: {e}")
    return row_id


def join_link(cfg: dict, server_id: str | None) -> str | None:
    if not cfg.get("place_id") or not server_id:
        return None
    return (f"https://www.roblox.com/games/start"
            f"?placeId={cfg['place_id']}&gameInstanceId={server_id}")


def fan_out(cfg: dict, spawn: Spawn, server_id: str | None,
            spotter: str | None, source: str) -> None:
    """POST a Discord webhook embed. Sync + best-effort by design."""
    url = cfg.get("notify_webhook_url")
    if not url:
        print(f"[fanout] no webhook configured; would ping {spawn.pretty}")
        return

    role_id = (cfg.get("ping_roles") or {}).get(spawn.rarity.lower(), 0)
    content = f"<@&{role_id}> " if role_id else ""

    link = join_link(cfg, server_id)
    desc_lines = [
        f"**{spawn.pretty}** spawned in **{spawn.biome}**",
    ]
    if link:
        desc_lines.append(f"🔗 [**JOIN SERVER**]({link})")
    if spotter:
        desc_lines.append(f"*spotted by {spotter} ({source})*")

    embed = {
        "title": f"🥚 {spawn.rarity} Egg — {spawn.egg}",
        "description": "\n".join(desc_lines),
        "color": 0x9B59B6,
        "footer": {"text": "eggwatch notifier"},
    }
    with httpx.Client(timeout=10) as client:
        client.post(url, json={"content": content, "embeds": [embed]})
