"""Pure-logic tests (no network, no discord, no tesseract):
    python tests/test_logic.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common.banner import parse_banners, rarity_at_least, Spawn
from common.predictor import next_reset, anchor_from_timestamp, odds_text
from api.db import connect, insert_capture, cycle_index


def test_real_banner_with_emoji():
    text = "👋 Say hi to everyone playing now!\nA Eternal Oni Tiger Egg spawned in Cherry Blossom🌸!"
    spawns = parse_banners(text)
    assert len(spawns) == 1, spawns
    s = spawns[0]
    assert s.rarity == "Eternal"
    assert s.egg == "Oni Tiger"
    assert s.biome == "Cherry Blossom"


def test_ocr_garbage_tolerant():
    # OCR commonly mangles spacing/case; emojis become junk
    text = "a ETERNAL 0ni Tiger EGG spawned in Cherry Blossom!"
    spawns = parse_banners(text)
    assert len(spawns) == 1
    assert spawns[0].rarity == "Eternal"
    assert spawns[0].egg.lower() == "0ni tiger"  # OCR text kept verbatim (title-cased)


def test_multiple_banners():
    text = ("A Divine Kitsune Egg spawned in Shadow Realm! "
            "A Common Rock Egg spawned in Meadow!")
    spawns = parse_banners(text)
    assert len(spans := spawns) == 2
    assert spans[0].rarity_rank > spans[1].rarity_rank


def test_non_spawn_text_ignored():
    assert parse_banners("You completed a quest! Server restarted in 3s") == []


def test_rarity_order():
    assert rarity_at_least("Eternal", "Eternal")
    assert rarity_at_least("Cosmic", "Eternal")
    assert not rarity_at_least("Mythic", "Eternal")


def test_predictor_math():
    cycle = 300
    epoch = anchor_from_timestamp(1_000_000_000.0, cycle)
    assert epoch % cycle == 0
    p = next_reset(now=epoch + 47.0, epoch=epoch, cycle_seconds=cycle)
    assert p.anchored and p.next_reset_in == 253 and p.countdown() == "4:13"
    p2 = next_reset(now=epoch + 299.5, epoch=epoch, cycle_seconds=cycle)
    assert abs(p2.next_reset_in - 0.5) < 0.01
    p3 = next_reset(now=epoch + 301.0, epoch=epoch, cycle_seconds=cycle)
    assert p3.cycle_number == 2


def test_db_dedupe(tmp_path="test_eggwatch.db"):
    conn = connect(tmp_path)
    a = insert_capture(conn, egg="Oni Tiger", rarity="Eternal", biome="Cherry Blossom",
                       server_id="abc", source="test", spotter="tester")
    b = insert_capture(conn, egg="Oni Tiger", rarity="Eternal", biome="Cherry Blossom",
                       server_id="abc", source="test", spotter="tester2")
    c = insert_capture(conn, egg="Oni Tiger", rarity="Eternal", biome="Cherry Blossom",
                       server_id="OTHER", source="test", spotter="tester")
    assert a is not None and b is None and c is not None
    n = conn.execute("SELECT COUNT(*) AS n FROM captures").fetchone()["n"]
    assert n == 2
    conn.close()
    Path(tmp_path).unlink(missing_ok=True)
    for suffix in ("-wal", "-shm"):
        Path(tmp_path + suffix).unlink(missing_ok=True)


def test_odds_text():
    txt = odds_text({"eternal": 0.003, "cosmic": 0.0002, "mythic": 0.20})
    assert "20%" in txt and "Mythic" in txt
    assert "1 in 5,000" in txt  # cosmic


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"\n{len(fns)} tests passed")
