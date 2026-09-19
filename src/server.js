// Express API — same endpoints as the Python version had.
import express from "express";
import { parseBanners } from "./banner.js";
import { nextReset } from "./predictor.js";
import { ingestSpawn, fanOut, checkCodeRow, VerificationError } from "./service.js";
import { resolveUsername, getProfile } from "./roblox.js";

export function buildServer(db, cfg) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() / 1000 }));

  // ------------------------------------------------------------- verify --

  app.post("/api/verify/start", async (req, res) => {
    try {
      const { discord_id: discordId, roblox_username: username } = req.body || {};
      if (!discordId || !username) return res.status(400).json({ error: "discord_id and roblox_username required" });
      const user = await resolveUsername(String(username).trim());
      const code = db.createCode(String(discordId), user.name, user.id);
      res.json({ code, roblox_user_id: user.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/verify/check/:discordId", async (req, res) => {
    const row = db.pendingCode(req.params.discordId);
    if (!row) return res.status(400).json({ error: "No pending code" });
    try {
      const result = await checkCodeRow(db, row, cfg.verify_code_ttl_minutes);
      res.json({ verified: true, ...result });
    } catch (e) {
      if (e instanceof VerificationError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  // ----------------------------------------------------------- captures --

  app.post("/api/capture", (req, res) => {
    const { egg, rarity, biome, server_id, source = "scanner", spotter = null } = req.body || {};
    if (!egg || !rarity || !biome) return res.status(400).json({ error: "egg, rarity, biome required" });
    const rowId = ingestSpawn(db, cfg, { egg, rarity, biome }, {
      server_id: server_id ?? null, source, spotter, fanoutFn: fanOut,
    });
    res.json(rowId === null ? { status: "duplicate" } : { status: "stored", id: rowId });
  });

  app.post("/api/capture/text", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : String(req.query.text || "");
    const results = [];
    for (const s of parseBanners(text)) {
      const rowId = ingestSpawn(db, cfg, s, { server_id: null, source: "text", spotter: null, fanoutFn: fanOut });
      results.push({ spawn: `${s.rarity} ${s.egg} Egg`, status: rowId === null ? "duplicate" : "stored" });
    }
    res.json({ found: results.length, results });
  });

  app.get("/api/spawns", (req, res) => res.json(db.recentCaptures(Number(req.query.limit) || 25)));
  app.get("/api/leaderboard", (_req, res) => res.json(db.leaderboard(10)));

  app.get("/api/predict", (_req, res) => {
    const epoch = db.getSetting("cycle_epoch");
    const p = nextReset({ epoch: epoch ? Number(epoch) : null, cycleSeconds: cfg.cycle_seconds });
    res.json({
      next_reset_in: p.nextResetIn,
      cycle_number: p.cycleNumber,
      anchored: p.anchored,
      odds: cfg.cycle_odds,
    });
  });

  // probe a roblox profile (used by tools, harmless public data)
  app.get("/api/roblox/:username", async (req, res) => {
    try {
      const user = await resolveUsername(req.params.username);
      const profile = await getProfile(user.id);
      res.json({ id: user.id, name: user.name, display: user.displayName, about: profile.description });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  return app;
}
