// Config loader. Precedence: EGW_<KEY> env var > config.json > defaults.
// So hosts (Railway) are configured entirely via env vars — no secrets in git.
import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  // -- Discord --
  bot_token: "",
  guild_id: 0,
  verified_role_id: 0,
  verify_channel_id: "1550689778717036554", // verification panel lives here
  announce_channel_id: "1550697264970862673", // ✅ verified announcements go here
  // relay: his bot posts into hidden inboxes, we re-emit our design into outputs
  inbox_channel_id: "1550702812697075732",        // notifier feed inbox
  notifier_output_channel_id: "1550426915200966657",
  lastseen_channel_id: "1550702844313866261",     // last-seen feed inbox
  lastseen_output_channel_id: "1550427008130088960",
  screenshot_channel_id: 0,
  notify_webhook_url: "",
  // -- Game --
  place_id: 0,
  // -- API --
  api_host: "127.0.0.1",
  api_port: 8720,
  database_path: "eggwatch.db",
  // -- Pings --
  min_rarity_to_ping: "Eternal",
  ping_roles: { eternal: 0, divine: 0, cosmic: 0, secret: 0 },
  // -- Predictor --
  cycle_seconds: 300,
  cycle_odds: { mythic: 0.2, secret: 0.01, eternal: 0.003, divine: 0.001, cosmic: 0.0002 },
  // -- Verification --
  verify_code_ttl_minutes: 30,
  verify_poll_seconds: 15, // auto-scan pending codes this often
  // -- Scanner (member PC) --
  api_url: "http://127.0.0.1:8720",
  roblox_username: "",
};

export function loadConfig(file = "config.json") {
  const cfg = { ...DEFAULTS };
  const p = path.resolve(file);
  if (fs.existsSync(p)) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(p, "utf8")));
  }
  for (const key of Object.keys(cfg)) {
    const env = process.env[`EGW_${key.toUpperCase()}`];
    if (env === undefined) continue;
    if (typeof cfg[key] === "boolean") cfg[key] = ["1", "true", "yes"].includes(env.toLowerCase());
    else if (typeof cfg[key] === "number") {
      const n = Number(env);
      if (!Number.isNaN(n)) cfg[key] = n;
    } else if (typeof cfg[key] === "object" && cfg[key] !== null) {
      try { cfg[key] = JSON.parse(env); } catch { /* keep default */ }
    } else cfg[key] = env;
  }
  return cfg;
}
