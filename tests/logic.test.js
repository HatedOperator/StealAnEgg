import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { parseBanners, rarityAtLeast } from "../src/banner.js";
import { nextReset, anchorFromTimestamp, oddsText, countdown } from "../src/predictor.js";
import { DB } from "../src/db.js";

test("real banner with emoji", () => {
  const spawns = parseBanners("👋 Say hi to everyone playing now!\nA Eternal Oni Tiger Egg spawned in Cherry Blossom🌸!");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].rarity, "Eternal");
  assert.equal(spawns[0].egg, "Oni Tiger");
  assert.equal(spawns[0].biome, "Cherry Blossom");
});

test("OCR-mangled text still parses", () => {
  const spawns = parseBanners("a ETERNAL 0ni Tiger EGG spawned in Cherry Blossom!");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].egg.toLowerCase(), "0ni tiger");
});

test("multiple banners rank-ordered", () => {
  const spawns = parseBanners("A Divine Kitsune Egg spawned in Shadow Realm! A Common Rock Egg spawned in Meadow!");
  assert.equal(spawns.length, 2);
  assert.ok(rarityAtLeast(spawns[0].rarity, "Eternal"));
  assert.ok(!rarityAtLeast(spawns[1].rarity, "Eternal"));
});

test("non-spawn text ignored", () => {
  assert.deepEqual(parseBanners("You completed a quest! Server restarted in 3s"), []);
});

test("predictor math", () => {
  const cycle = 300;
  const epoch = anchorFromTimestamp(1_000_000_000, cycle);
  assert.equal(epoch % cycle, 0);
  const p = nextReset({ now: epoch + 47, epoch, cycleSeconds: cycle });
  assert.equal(p.anchored, true);
  assert.equal(Math.round(p.nextResetIn), 253);
  assert.equal(countdown(p.nextResetIn), "4:13");
  const p3 = nextReset({ now: epoch + 301, epoch, cycleSeconds: cycle });
  assert.equal(p3.cycleNumber, 2);
});

test("odds text formats", () => {
  const txt = oddsText({ eternal: 0.003, cosmic: 0.0002, mythic: 0.2 });
  assert.match(txt, /Mythic.*20%/);
  assert.match(txt, /1 in 5,000/);
});

test("db dedupe + verification codes", () => {
  const path = "test_logic.db";
  fs.rmSync(path, { force: true });
  const db = new DB(path);

  const a = db.insertCapture({ egg: "Oni Tiger", rarity: "Eternal", biome: "Cherry Blossom", server_id: "abc", source: "t" });
  const b = db.insertCapture({ egg: "Oni Tiger", rarity: "Eternal", biome: "Cherry Blossom", server_id: "abc", source: "t" });
  const c = db.insertCapture({ egg: "Oni Tiger", rarity: "Eternal", biome: "Cherry Blossom", server_id: "zzz", source: "t" });
  assert.ok(a !== null && b === null && c !== null);

  const code = db.createCode("123", "builderman", 156);
  assert.match(code, /^EGG-/);
  assert.equal(db.pendingCode("123").code, code);
  db.completeCode(db.pendingCode("123"), 156);
  assert.equal(db.getLink("123").roblox_username, "builderman");
  assert.equal(db.allPending().length, 0);

  db.conn.close();
  fs.rmSync(path, { force: true });
  fs.rmSync(path + "-wal", { force: true });
  fs.rmSync(path + "-shm", { force: true });
});
