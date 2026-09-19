"""Shared banner parser.

The game announces rare spawns to everyone in the server with a banner in the
shape of:  "A Eternal Oni Tiger Egg spawned in Cherry Blossom🌸!"

Both the tray scanner (live OCR of your own screen) and the Discord screenshot
fallback feed text through parse_banners() so the rest of the pipeline never
cares where the text came from.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Ordered lowest -> highest. Used both for parsing and for ping thresholds.
RARITIES: list[str] = [
    "Common",
    "Uncommon",
    "Rare",
    "Epic",
    "Legendary",
    "Mythic",
    "Secret",
    "Eternal",
    "Divine",
    "Cosmic",
]

RARITY_ORDER: dict[str, int] = {r.lower(): i for i, r in enumerate(RARITIES)}


@dataclass
class Spawn:
    egg: str
    rarity: str
    biome: str

    @property
    def rarity_rank(self) -> int:
        return RARITY_ORDER.get(self.rarity.lower(), -1)

    @property
    def pretty(self) -> str:
        return f"{self.rarity} {self.egg} Egg"


_BANNER_RE = re.compile(
    r"\b(?P<rarity>" + "|".join(RARITIES) + r")\s+"
    r"(?P<egg>[A-Za-z0-9][A-Za-z0-9'’\- ]*?)\s+"
    r"egg\s+spawned\s+in\s+"
    r"(?P<biome>[A-Za-z][A-Za-z0-9'’\- ]*)",
    re.IGNORECASE,
)


def _clean(text: str) -> str:
    # Strip emojis / non-ascii junk that OCR trips over ("Cherry Blossom🌸!")
    return re.sub(r"[^\x00-\x7F]+", " ", text)


def parse_banners(text: str) -> list[Spawn]:
    """Return every spawn announcement found in a blob of OCR text."""
    spawns: list[Spawn] = []
    for m in _BANNER_RE.finditer(_clean(text)):
        spawns.append(
            Spawn(
                egg=m.group("egg").strip().title(),
                rarity=m.group("rarity").capitalize(),
                biome=m.group("biome").strip().title(),
            )
        )
    return spawns


def rarity_at_least(rarity: str, minimum: str) -> bool:
    a = RARITY_ORDER.get(rarity.lower(), -1)
    b = RARITY_ORDER.get(minimum.lower(), -1)
    return a >= 0 and b >= 0 and a >= b
