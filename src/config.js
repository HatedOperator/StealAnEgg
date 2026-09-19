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
  screenshot_channel_id: "1544152945644273774", // screenshots posted here get OCR'd
  // -- Pings --
  min_rarity_to_ping: "Eternal",
  ping_roles: {
    secret: "1550705211381653524",
    eternal: "1550705207149731963",
    divine: "1550705206667382874",
    cosmic: "1550710049834537042",
  },
  // -- Predictor --
  cycle_seconds: 300,
  cycle_odds: { mythic: 0.2, secret: 0.01, eternal: 0.003, divine: 0.001, cosmic: 0.0002 },
  // -- Telemetry: Admin Abuse watcher (updates are handled manually) --
  admin_abuse_channel_id: "1544152542793965578",
  admin_abuse_role: "1550745442545836053", // role pinged on abuse warning + live
  admin_abuse_day: 6,           // 0=Sun ... 6=Sat
  admin_abuse_utc_hour: 15,     // 15:00 UTC = 11 AM ET
  admin_abuse_warn_minutes: 15, // heads-up X minutes before

  // -- Verification --
  verify_code_ttl_minutes: 30,
  predict_role_id: 0, // 0 = /predict open to everyone; otherwise role-gated
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
