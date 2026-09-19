// Entry point: one process runs the bot AND the API (single Railway service,
// single volume, no Procfile split needed).
import { loadConfig } from "./config.js";
import { DB } from "./db.js";
import { buildServer } from "./server.js";
import { buildBot } from "./bot.js";

const cfg = loadConfig();
const db = new DB(cfg.database_path);

const port = Number(process.env.PORT) || cfg.api_port;
const host = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : cfg.api_host;

buildServer(db, cfg).listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port}`);
});

if (cfg.bot_token) {
  const bot = buildBot(db, cfg);
  bot.login(cfg.bot_token).catch((e) => {
    console.error("[bot] login failed:", e.message);
    console.error("[bot] check EGW_BOT_TOKEN and the Message Content Intent toggle in the Discord dev portal");
    process.exit(1);
  });
} else {
  console.warn("[bot] no bot_token set — running API-only");
}
