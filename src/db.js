// SQLite storage via node:sqlite (built into Node >= 22.13 — no native builds).
// Single process: bot + API share one connection.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
    discord_id      TEXT PRIMARY KEY,
    roblox_user_id  INTEGER NOT NULL,
    roblox_username TEXT NOT NULL,
    verified_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
    code            TEXT PRIMARY KEY,
    discord_id      TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    roblox_user_id  INTEGER,
    created_at      REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS captures (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    egg          TEXT NOT NULL,
    rarity       TEXT NOT NULL,
    biome        TEXT NOT NULL,
    server_id    TEXT,
    cycle_index  INTEGER NOT NULL,
    source       TEXT NOT NULL,
    spotter      TEXT,
    created_at   REAL NOT NULL,
    UNIQUE(server_id, egg, cycle_index)
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export class DB {
  constructor(dbPath = "eggwatch.db") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.conn = new DatabaseSync(dbPath);
    try { this.conn.exec("PRAGMA journal_mode = WAL"); } catch { /* fine */ }
    this.conn.exec(SCHEMA);
  }

  getSetting(key) {
    const row = this.conn.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.conn
      .prepare("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, String(value));
  }

  // ------------------------------------------------------------ captures --

  insertCapture({ egg, rarity, biome, server_id = null, source, spotter = null, cycle_seconds = 300 }) {
    const now = Date.now() / 1000;
    const serverKey = server_id || ""; // NULLs defeat UNIQUE dedupe
    try {
      const info = this.conn
        .prepare(
          `INSERT INTO captures(egg, rarity, biome, server_id, cycle_index, source, spotter, created_at)
           VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(egg, rarity, biome, serverKey, Math.floor(now / cycle_seconds), source, spotter, now);
      return Number(info.lastInsertRowid);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return null; // duplicate
      throw e;
    }
  }

  recentCaptures(limit = 25) {
    return this.conn.prepare("SELECT * FROM captures ORDER BY id DESC LIMIT ?").all(Math.min(limit, 100));
  }

  leaderboard(limit = 10) {
    return this.conn
      .prepare("SELECT spotter, COUNT(*) AS catches FROM captures WHERE spotter IS NOT NULL GROUP BY spotter ORDER BY catches DESC LIMIT ?")
      .all(limit);
  }

  // -------------------------------------------------------- verification --

  createCode(discordId, robloxUsername, robloxUserId) {
    const code = `EGG-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    this.conn
      .prepare(
        `INSERT INTO codes(code, discord_id, roblox_username, roblox_user_id, created_at, status)
         VALUES(?,?,?,?,?,'pending')`
      )
      .run(code, discordId, robloxUsername, robloxUserId, Date.now() / 1000);
    this.conn
      .prepare(`UPDATE codes SET status='superseded' WHERE discord_id=? AND status='pending' AND code!=?`)
      .run(discordId, code);
    return code;
  }

  pendingCode(discordId) {
    return this.conn
      .prepare("SELECT * FROM codes WHERE discord_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1")
      .get(discordId);
  }

  allPending() {
    return this.conn.prepare("SELECT * FROM codes WHERE status='pending'").all();
  }

  completeCode(codeRow, robloxUserId) {
    this.conn
      .prepare(
        `INSERT INTO links(discord_id, roblox_user_id, roblox_username, verified_at)
         VALUES(?,?,?,?)
         ON CONFLICT(discord_id) DO UPDATE SET
           roblox_user_id=excluded.roblox_user_id,
           roblox_username=excluded.roblox_username,
           verified_at=excluded.verified_at`
      )
      .run(codeRow.discord_id, robloxUserId, codeRow.roblox_username, new Date().toISOString());
    this.conn.prepare("UPDATE codes SET status='used' WHERE code=?").run(codeRow.code);
  }

  getLink(discordId) {
    return this.conn.prepare("SELECT * FROM links WHERE discord_id=?").get(discordId);
  }
}
