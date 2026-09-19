# Steal an Egg notifier

Community spawn notifier for Roblox's **Steal an Egg** — Discord bot + ingest
API + member-side screen scanner, **all JavaScript** (Node ≥ 22.13, no native
builds: sqlite and OCR are built into Node / WASM).

Players' own screens are the sensors: no game ownership, no scanner-account
farms, no client injection — passive OCR of a screen the player already owns.

## One process

`node src/index.js` runs the bot **and** the API together (single Railway
service, single volume).

```
player's screen ──► scanner OCR ──► POST /api/capture ──► dedupe (server+egg+cycle)
screenshot post ──► bot OCR     ──►        ⋮                        │
                                                                     ▼
                                          rarity >= ping threshold? ──► Discord webhook
                                          (embed + roblox.com/games/start join link)
```

## Verification (button/modal flow — members never type commands)

The bot posts a **Verify Me** panel in the verify channel (set
`verify_channel_id`). Flow:

1. Member clicks **Verify Me** → a modal pops up → they type their Roblox username
2. Bot resolves it on Roblox and shows a card — *"Is this the right account?"*
   (username, display name, profile link, avatar) with **Yes / No** buttons
3. **Yes** → bot shows their code (`EGG-XXXX`) and instructions: paste it into
   their roblox.com **About** blurb. Message is ephemeral (only they see it)
4. Done — either they hit **I've Added It**, or the bot **auto-re-checks every
   15 seconds** and completes on its own. Role granted + public ✅ confirmation
   posted in the channel. They can delete the blurb afterwards.

## Setup

1. `npm install`
2. `cp config.example.json config.json` — fill in token/IDs (or use `EGW_*`
   env vars; env wins over file)
3. `node src/index.js`

Discord dev portal: enable **Message Content Intent** (Bot → Privileged
Gateway Intents). Bot needs Send Messages + Manage Roles in the verify channel.

## Deploying (Railway)

Deploy this repo; Procfile runs `node src/index.js` (web only — the bot rides
in the same process).

1. **Volume** mounted at `/data` + `EGW_DATABASE_PATH=/data/eggwatch.db`
   (otherwise the DB resets every redeploy)
2. Env vars: `EGW_BOT_TOKEN`, `EGW_GUILD_ID`, `EGW_VERIFIED_ROLE_ID`,
   `EGW_VERIFY_CHANNEL_ID`, `EGW_SCREENSHOT_CHANNEL_ID`,
   `EGW_NOTIFY_WEBHOOK_URL`, `EGW_PLACE_ID`, and `EGW_PING_ROLES` as JSON,
   e.g. `{"eternal":"123","divine":"456"}`
3. Members' scanners: `"api_url": "https://<your-app>.up.railway.app"`
   in their local config.json

## Member scanner

Windows, run while playing: `node src/scanner.js` (needs the repo +
`npm install`). Finds the Roblox window, OCRs the spawn banner strip every 2s
("A Eternal Oni Tiger Egg spawned in Cherry Blossom🌸!"), resolves the current
server's jobId from the client's launch arguments (passive OS query), and
reports to the API with your verified username for credit.

## Endpoints

`GET /api/health` · `POST /api/capture` · `POST /api/capture/text` ·
`GET /api/spawns` · `GET /api/predict` · `GET /api/leaderboard` ·
`POST /api/verify/start` · `GET /api/verify/check/:discordId` ·
`GET /api/roblox/:username`

## Commands

`/predict` (reset countdown + odds) · `/spawns` (recent) · `/panel` (repost
verification panel)

## Notes

- All Roblox calls hit public endpoints — no cookies, no auth.
- Dedupe key: `(server, egg, cycle)` — one spotter per server is enough.
- Tests: `npm test`
- Banner OCR region: top 15% of the game window — tweak in `src/scanner.js`
  if banners render elsewhere for you.
