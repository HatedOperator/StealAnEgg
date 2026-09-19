"""Cycle timer + calibrated rarity odds.

Two honest kinds of prediction:
1. Timing — the map's eggs reset on a fixed cycle (default 5 min). Once we've
   seen a single real capture we can anchor the grid and count down exactly.
2. Rarity — per-cycle odds per server from the config table. Output is
   weather-forecast style: confident about the clock, honest about the dice.
"""
from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass
class Prediction:
    next_reset_in: int          # seconds until next reset
    cycle_number: int
    anchored: bool

    def countdown(self) -> str:
        m, s = divmod(int(self.next_reset_in), 60)
        return f"{m}:{s:02d}"


def anchor_from_timestamp(ts: float, cycle_seconds: int) -> int:
    """Snap an observed capture time onto the cycle grid; use as epoch."""
    return int(ts - (ts % cycle_seconds))


def next_reset(now: float | None = None, epoch: float | None = None,
               cycle_seconds: int = 300) -> Prediction:
    now = time.time() if now is None else now
    if epoch is None:
        # Not anchored yet: count down on a provisional grid from boot time.
        epoch = 0
        elapsed = now % cycle_seconds
        return Prediction(cycle_seconds - elapsed, 0, anchored=False)
    elapsed = now - epoch
    cycle_number = int(elapsed // cycle_seconds) + 1
    remaining = cycle_seconds - (elapsed % cycle_seconds)
    return Prediction(remaining, cycle_number, anchored=True)


def odds_text(odds: dict[str, float]) -> str:
    """Human-readable per-cycle odds, highest tier first."""
    lines = []
    for rarity in sorted(odds, key=lambda r: odds[r], reverse=True):
        p = odds[rarity]
        if p >= 0.001:
            lines.append(f"**{rarity.title()}** ~{p * 100:g}% per cycle")
        else:
            lines.append(f"**{rarity.title()}** ~1 in {int(round(1 / p)):,} cycles")
    return "\n".join(lines)
