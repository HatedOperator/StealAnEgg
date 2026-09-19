"""Thin client for the public Roblox web APIs we need.

Everything here is unauthenticated GET/POST against documented-ish public
endpoints. Only used for: resolving usernames, reading profile About text
(for the verification code), and server lists.
"""
from __future__ import annotations

import asyncio

import httpx

UA = {"User-Agent": "eggwatch-notifier/0.1 (community tool; +discord)"}
USERS_BASE = "https://users.roblox.com"
GAMES_BASE = "https://games.roblox.com"


class RobloxError(Exception):
    pass


async def resolve_username(client: httpx.AsyncClient, username: str) -> dict:
    r = await client.post(
        f"{USERS_BASE}/v1/usernames/users",
        json={"usernames": [username]},
        headers=UA,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    if not data:
        raise RobloxError(f"No Roblox user named {username!r}")
    return data[0]  # {"id", "name", "displayName"}


async def get_profile(client: httpx.AsyncClient, user_id: int) -> dict:
    r = await client.get(f"{USERS_BASE}/v1/users/{user_id}", headers=UA)
    r.raise_for_status()
    return r.json()  # includes "description" (the About blurb)


async def fetch_about_text(client: httpx.AsyncClient, username: str) -> tuple[int, str]:
    """Return (roblox_user_id, profile_about_text) for a username."""
    user = await resolve_username(client, username)
    profile = await get_profile(client, user["id"])
    return user["id"], profile.get("description") or ""


async def list_servers(client: httpx.AsyncClient, place_id: int,
                       sort_order: int = 2) -> list[dict]:
    """Public live servers for a place: [{id, playing, maxPlayers, fps}, ...]."""
    r = await client.get(
        f"{GAMES_BASE}/v1/games/{place_id}/servers/0",
        params={"sortOrder": sort_order, "limit": 100},
        headers=UA,
    )
    if r.status_code == 429:
        raise RobloxError("Rate limited by Roblox; back off")
    r.raise_for_status()
    return r.json().get("data", [])


async def main_demo() -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        uid, about = await fetch_about_text(client, "builderman")
        print(uid, about[:80])


if __name__ == "__main__":
    asyncio.run(main_demo())
