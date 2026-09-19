# eggwatch — Steal an Egg notifier

A community spawn notifier built **without owning the game and without scanner
account farms**: real players' own screens are the sensors.

Three moving parts:

| Piece | What it does | Run |
|---|---|---|
| **API** (`api/`) | Verification codes + Roblox account linking, capture ingest with dedupe, cycle predictor, Discord webhook fan-out | `python -m uvicorn api.main:app --port 8720` |
| **Bot** (`bot/`) | `/verify`, `/verifydone`, `/predict`, `/spawns`, and auto-OCR of any screenshot posted in the capture channel | `python -m bot.main` |
| **Scanner** (`scanner/`) | Member-side sensor: watches your own Roblox window, OCRs the spawn banner, resolves your current server, auto-reports | `python -m scanner.main` |

## How the data flows

```
player's screen ──► scanner OCR ──► POST /api/capture ──► dedupe (server+egg+cycle)
screenshot post ──► bot OCR     ──►        ⋮                        │
                                                                     ▼
                                          rarity >= ping threshold? ──► Discord webhook
                                          (embed + roblox.com/games/start join link)
```

The game announces rare spawns to everyone in the server with a banner like
`A Eternal Oni Tiger Egg spawned in Cherry Blossom!` — that banner is the only
thing we read. Passive pixels on a screen the player already owns; no client
injection, no modified Roblox, no bot accounts.

## Setup

1. **Python 3.10+**, then: `pip install -r requirements.txt`
2. **Tesseract** (OCR engine): install the Windows build from
   https://github.com/UB-Mannheim/tesseract/wiki — default path is already in
   `config.example.json`
3. `copy config.example.json config.json` and fill in:
   - `bot_token` — from https://discord.com/developers/applications (enable
     **Message Content Intent** on the Bot page)
   - `guild_id`, `verified_role_id`, `screenshot_channel_id` (right-click →
     Copy ID in Discord, dev mode)
   - `notify_webhook_url` — create a webhook in your alert channel
   - `place_id` — the number in the game's Roblox URL
   - `ping_roles` — rarity → role IDs members opt into
   - `cycle_odds` — per-cycle rarity odds per server (the predictor's honesty
     lives here; tune from real capture data over time)
4. Start the API, then the bot. Players run the scanner on their own PCs.

## Verification flow (members)

1. `/verify username:YourRobloxName` → bot DMs a code like `EGG-7F3K`
2. Paste the code into your Roblox **About** blurb (roblox.com → Settings)
3. `/verifydone` → bot reads your public profile, matches the code, links the
   accounts and grants the verified role (delete the blurb after)
4. Every capture the scanner or screenshots produce is now credited to that
   Roblox account — `/api/leaderboard` ranks spotters

## Tuning the OCR

The banner region is the top ~15% of the Roblox window. If OCR misses:
- check `tesseract_cmd` is right
- tweak `banner_region()` in `scanner/main.py` to where banners render for you
- the parser (`common/banner.py`) tolerates case/spacing/emoji mangling, but
  new rarity tiers must be added to `RARITIES`

## Deploying (Railway)

The repo ships with a `Procfile`: `web` runs the API, `worker` runs the bot —
deploy the repo as a Railway service and enable both processes. Then:

1. **Mount a volume** (e.g. `/data`) and set `EGW_DATABASE_PATH=/data/eggwatch.db`
   — otherwise SQLite resets on every redeploy.
2. **Set env vars** (everything is `EGW_<KEY>` — no config.json on the server):
   `EGW_BOT_TOKEN`, `EGW_GUILD_ID`, `EGW_VERIFIED_ROLE_ID`,
   `EGW_SCREENSHOT_CHANNEL_ID`, `EGW_NOTIFY_WEBHOOK_URL`, `EGW_PLACE_ID`,
   and `EGW_PING_ROLES` as JSON, e.g.
   `{"eternal": "123", "divine": "456"}`.
3. Members' scanners point at your Railway public URL:
   `"api_url": "https://<your-app>.up.railway.app"`.

Note: the bot process must stay on the **same service** as the API (they share
the SQLite file on the volume). The scanner never runs on Railway — it runs on
each player's own PC, by design.

## Notes

- All Roblox calls hit public endpoints (`users.roblox.com`, `games.roblox.com`)
  — no cookies, no auth, nothing ban-worthy.
- Dedupe key is `(server, egg, cycle)` so one spotter per server is enough and
  30 spotters don't double-ping.
- The predictor anchors its 5-minute grid on the first real capture; before
  that it counts down provisionally.
- Test the pure logic any time: `python tests/test_logic.py`

## Roadmap

- [ ] Package the scanner as a one-click exe (PyInstaller) for members
- [ ] Player-count telemetry → admin-event spike detection (`games.roblox.com`
      server list polling, already stubbed in `api/roblox.py:list_servers`)
- [ ] Auto-tune `cycle_odds` from accumulated captures
- [ ] Web dashboard of recent spawns
