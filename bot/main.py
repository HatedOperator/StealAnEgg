"""eggwatch Discord bot.

- /verify username      → DMs a code to put in your Roblox About
- /verifydone           → checks the code and links + roles you
- /predict              → cycle countdown + calibrated odds
- /spawns               → recent captures
- watches the screenshot channel and OCRs any posted image for spawn banners

Run:  python -m bot.main     (requires config.json next to the repo root)
"""
from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

import discord
from discord import app_commands

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api import service  # noqa: E402
from api.db import connect  # noqa: E402
from common.banner import parse_banners  # noqa: E402
from common.config import load_config  # noqa: E402
from common import ocr  # noqa: E402
from common.predictor import next_reset, odds_text  # noqa: E402

CFG = load_config()
CONN = connect(CFG.get("database_path", "eggwatch.db"))
ocr.configure(CFG)

intents = discord.Intents.default()
intents.message_content = True  # enable in the dev portal too

bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)


@bot.event
async def on_ready():
    await tree.sync()
    print(f"[bot] logged in as {bot.user}; commands synced")


# ------------------------------------------------------------- /verify ------

@tree.command(name="verify", description="Link your Roblox account to eggwatch")
@app_commands.describe(username="Your exact Roblox username")
async def verify(interaction: discord.Interaction, username: str):
    if service.get_link(CONN, str(interaction.user.id)):
        await interaction.response.send_message(
            "You're already verified ✅", ephemeral=True
        )
        return
    code = service.create_code(CONN, str(interaction.user.id), username.strip())
    try:
        await interaction.user.send(
            "**eggwatch verification**\n"
            "1. Log in at roblox.com\n"
            f"2. Settings → About → paste this code into your blurb:\n"
            f"```\n{code}\n```\n"
            "3. Save it, then run `/verifydone` in the server.\n"
            "You can delete the code right after."
        )
        await interaction.response.send_message(
            "📩 Check your DMs for the code, then run `/verifydone`.",
            ephemeral=True,
        )
    except discord.Forbidden:
        await interaction.response.send_message(
            "I can't DM you — open DMs from server members and retry.",
            ephemeral=True,
        )


@tree.command(name="verifydone", description="Finish verification (code in About)")
async def verifydone(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    try:
        link = await service.check_code(CONN, CFG, str(interaction.user.id))
    except service.VerificationError as e:
        await interaction.followup.send(f"❌ {e}", ephemeral=True)
        return

    role_id = CFG.get("verified_role_id")
    if role_id and interaction.guild:
        role = interaction.guild.get_role(int(role_id))
        if role:
            await interaction.user.add_roles(role)
    await interaction.followup.send(
        f"✅ Verified as **{link['roblox_username']}** "
        f"(roblox.com/users/{link['roblox_user_id']}/profile). "
        "Your client reports will now be credited automatically.",
        ephemeral=True,
    )


# ------------------------------------------------------------ /predict ------

@tree.command(name="predict", description="Next egg reset + rarity odds")
async def predict(interaction: discord.Interaction):
    from api.db import get_setting
    epoch_raw = get_setting(CONN, "cycle_epoch")
    epoch = float(epoch_raw) if epoch_raw else None
    p = next_reset(epoch=epoch, cycle_seconds=CFG.get("cycle_seconds", 300))
    anchor_note = "" if p.anchored else "\n*(not yet anchored — calibrates after first real capture)*"
    await interaction.response.send_message(
        f"⏱ **Next reset in {p.countdown()}** (cycle #{p.cycle_number}){anchor_note}\n\n"
        + odds_text(CFG.get("cycle_odds", {}))
    )


@tree.command(name="spawns", description="Recent confirmed spawns")
async def spawns(interaction: discord.Interaction):
    rows = CONN.execute(
        "SELECT * FROM captures ORDER BY id DESC LIMIT 10"
    ).fetchall()
    if not rows:
        await interaction.response.send_message("No captures yet — be the first sensor!")
        return
    lines = [
        f"`{r['rarity']:>9}` **{r['egg']}** — {r['biome']}"
        for r in rows
    ]
    await interaction.response.send_message("**Recent spawns**\n" + "\n".join(lines))


# ------------------------------------------------- screenshot OCR fallback --

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    channel_id = CFG.get("screenshot_channel_id")
    if not channel_id or message.channel.id != int(channel_id):
        return
    for att in message.attachments:
        if not (att.content_type or "").startswith("image/"):
            continue
        data = await att.read()
        try:
            text = await asyncio.to_thread(ocr.bytes_to_text, data)
        except Exception as e:
            print(f"[ocr] failed on {att.filename}: {e}")
            continue
        found = parse_banners(text)
        for spawn in found:
            link = service.get_link(CONN, str(message.author.id))
            spotter = link["roblox_username"] if link else message.author.display_name
            row_id = service.ingest_spawn(
                CONN, CFG, spawn,
                server_id=None, source="screenshot", spotter=spotter,
            )
            if row_id:
                await message.reply(
                    f"📥 Captured **{spawn.pretty}** in **{spawn.biome}** — credited to {spotter}"
                )


def main():
    if not CFG.get("bot_token"):
        raise SystemExit("Set bot_token in config.json first")
    bot.run(CFG["bot_token"])


if __name__ == "__main__":
    main()
