// Discord bot: button+modal verification (no typing commands), spawn pings,
// /predict + /spawns, screenshot OCR fallback.
//
// Verification flow (all in cfg.verify_channel_id):
//   [Verify Me] button → modal (username) → "is this you?" card w/ Yes/No
//   → Yes: code + instructions ("I've Added It" button)
//   → either they hit the button, or the poller auto-checks every 15s.
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder,
  Events, ChannelType, PermissionFlagsBits, MessageFlags,
} from "discord.js";
import { parseBanners } from "./banner.js";
import { nextReset, countdown, oddsText } from "./predictor.js";
import { resolveUsername, getHeadshotUrl } from "./roblox.js";
import { checkCodeRow, ingestSpawn, fanOut, VerificationError } from "./service.js";
import * as ocr from "./ocr.js";

const ID = {
  start: "eggv:start",
  modal: "eggv:modal",
  yes: "eggv:yes",
  no: "eggv:no",
  done: "eggv:done",
  panel: "eggv:panel",
};

export function buildBot(db, cfg) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  // One bad interaction must never take the whole bot down.
  client.on("error", (e) => console.error("[client]", e));
  process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

  const commands = [
    new SlashCommandBuilder().setName("predict").setDescription("Next egg reset + rarity odds"),
    new SlashCommandBuilder().setName("spawns").setDescription("Recent confirmed spawns"),
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Repost the verification panel in the verify channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ];

  // ------------------------------------------------------------ helpers --

  const fetchTextChannel = async (id) => {
    if (!id) return null;
    try {
      const ch = await client.channels.fetch(String(id));
      return ch?.type === ChannelType.GuildText ? ch : null;
    } catch {
      return null;
    }
  };

  const verifyChannel = () => fetchTextChannel(cfg.verify_channel_id);

  const grantRole = async (guild, discordId) => {
    if (!cfg.verified_role_id || !guild) return;
    try {
      const member = await guild.members.fetch(discordId);
      await member.roles.add(String(cfg.verified_role_id));
    } catch (e) {
      console.error("[verify] role grant failed:", e.message);
    }
  };

  const announceVerified = async (discordId, robloxUsername, robloxUserId) => {
    const ch = (await fetchTextChannel(cfg.announce_channel_id)) ?? (await verifyChannel());
    if (!ch) return console.warn("[verify] no announce channel configured");
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Account verified")
          .setColor(0x57f287)
          .setDescription(
            `<@${discordId}> is now verified as **${robloxUsername}**\n` +
            `roblox.com/users/${robloxUserId}/profile\n` +
            `Your scanner reports will be credited automatically.`
          ),
      ],
    });
  };

  const verifySuccess = async (codeRow, { interaction = null, guild = null, discordId = null } = {}) => {
    const result = await checkCodeRow(db, codeRow, cfg.verify_code_ttl_minutes);
    const gid = interaction?.guild?.id ?? guild?.id;
    const uid = interaction?.user?.id ?? discordId;
    if (gid && uid) {
      const g = interaction?.guild ?? client.guilds.cache.get(gid) ?? guild;
      await grantRole(g, uid);
    }
    if (interaction) {
      await interaction
        .update({ content: "✅ Successfully verified", embeds: [], components: [] })
        .catch(() => {});
    }
    await announceVerified(uid, result.roblox_username, result.roblox_user_id);
    return result;
  };

  const codeInstructionsEmbed = (code, username) =>
    new EmbedBuilder()
      .setTitle("🥚 Almost there — add this code to your Roblox profile")
      .setColor(0x9b59b6)
      .setDescription(
      `1. Go to **roblox.com** → your **profile** (or gear ⚙ → Settings) → **About**\n` +
      `2. Edit the **description/blurb** and paste this code:\n` +
      "```\n" + code + "\n```\n" +
      `3. **Save** — Roblox may take a minute to show it (they cache profiles). Either hit **I've Added It**, or just wait: I re-check **every ${cfg.verify_poll_seconds}s** for 30 minutes and complete on my own.\n` +
        `_(Delete the code from your profile after — this message is only visible to you.)_`
      );

  // Auto-poller: scans pending codes every N seconds, no button press needed.
  const pollPending = async () => {
    for (const row of db.allPending()) {
      try {
        await verifySuccess(row, { discordId: row.discord_id });
        console.log(`[verify] auto-completed ${row.discord_id} -> ${row.roblox_username}`);
      } catch (e) {
        if (e instanceof VerificationError) {
          if (e.message.includes("expired")) {
            db.expireCode(row.code); // stop re-checking dead codes forever
            console.log(`[verify] expired ${row.code} (${row.discord_id})`);
          }
          continue; // "code-not-visible" just means Roblox cache hasn't caught up
        }
        console.error("[verify] poll error:", e.message);
      }
    }
  };

  // -------------------------------------------------------------- panel --

  const verificationModal = (title = "Roblox Verification") =>
    new ModalBuilder()
      .setCustomId(ID.modal)
      .setTitle(title)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("username")
            .setLabel("Your exact Roblox username")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        )
      );

  const panelPayload = () => ({
    embeds: [
      new EmbedBuilder()
        .setTitle("🥚 Verify your Roblox account")
        .setColor(0x5865f2)
        .setDescription(
          "Link your ROBLOX Account, to be eligible for **Robux Reward Claims** & **Faster Giveaway Claims**!\n\n" +
          "Already verified? Run it again any time to switch to a different Roblox account."
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ID.start).setLabel("Verify Me").setStyle(ButtonStyle.Primary)
      ),
    ],
  });

  const ensurePanel = async () => {
    const ch = await verifyChannel();
    if (!ch) return console.warn("[bot] verify_channel_id not set/found — panel not posted");
    const existingId = db.getSetting("verify_panel_message_id");
    if (existingId) {
      try {
        const msg = await ch.messages.fetch(existingId);
        await msg.edit(panelPayload());
        return;
      } catch { /* deleted — repost below */ }
    }
    const msg = await ch.send(panelPayload());
    db.setSetting("verify_panel_message_id", msg.id);
  };

  // ------------------------------------------------------------ events --

  client.once(Events.ClientReady, async () => {
    console.log(`[bot] logged in as ${client.user.tag}`);
    if (cfg.guild_id) {
      const guild = client.guilds.cache.get(String(cfg.guild_id));
      if (guild) await guild.commands.set(commands);
    } else {
      await client.application.commands.set(commands);
    }
    await ensurePanel();
    setInterval(pollPending, cfg.verify_poll_seconds * 1000);
  });

  client.on(Events.InteractionCreate, async (i) => {
    console.log(`[interaction] ${i.user.tag} -> ${i.isChatInputCommand() ? "/" + i.commandName : i.customId}`);
    try {
      if (i.isChatInputCommand()) return handleCommand(i);
      if (i.isButton()) return handleButton(i);
      if (i.isModalSubmit()) return handleModal(i);
    } catch (e) {
      console.error("[bot] interaction error:", e);
      const reply = i.deferred || i.replied ? i.followUp.bind(i) : i.reply.bind(i);
      await reply({ content: `❌ ${e.message || "Something went wrong."}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  async function handleCommand(i) {
    if (i.commandName === "predict") {
      const epoch = db.getSetting("cycle_epoch");
      const p = nextReset({ epoch: epoch ? Number(epoch) : null, cycleSeconds: cfg.cycle_seconds });
      const anchorNote = p.anchored ? "" : "\n*(calibrates after the first real capture)*";
      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⏱ Next egg reset")
            .setColor(0xfee75c)
            .setDescription(
              `**Reset in ${countdown(p.nextResetIn)}** (cycle #${p.cycleNumber})${anchorNote}\n\n` +
              oddsText(cfg.cycle_odds)
            ),
        ],
      });
    }
    if (i.commandName === "spawns") {
      const rows = db.recentCaptures(10);
      if (!rows.length) return i.reply("No captures yet — be the first sensor!");
      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🥚 Recent spawns")
            .setColor(0x9b59b6)
            .setDescription(
              rows
                .map((r) => `\`${r.rarity.padEnd(9)}\` **${r.egg}** — ${r.biome}`)
                .join("\n")
            ),
        ],
      });
    }
    if (i.commandName === "panel") {
      db.setSetting("verify_panel_message_id", ""); // force repost
      await ensurePanel();
      return i.reply({ content: "Panel refreshed ✅", flags: MessageFlags.Ephemeral });
    }
  }

  async function handleButton(i) {
    if (i.customId === ID.start) {
      // Verified members can re-verify — the new link simply overwrites the old one.
      const linked = !!db.getLink(i.user.id);
      return i.showModal(verificationModal(linked ? "Re-verify Roblox Account" : "Roblox Verification"));
    }

    if (i.customId === ID.yes) {
      const row = db.pendingCode(i.user.id);
      if (!row) return i.update({ content: "Session expired — hit Verify Me again.", embeds: [], components: [] });
      return i.update({
        embeds: [codeInstructionsEmbed(row.code, row.roblox_username)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(ID.done).setLabel("I've Added It").setStyle(ButtonStyle.Success)
          ),
        ],
      });
    }

    if (i.customId === ID.no) {
      // Reopen the username popup directly instead of sending them back to the panel.
      return i.showModal(verificationModal());
    }

    if (i.customId === ID.done) {
      const row = db.pendingCode(i.user.id);
      if (!row) return i.update({ content: "Session expired — hit Verify Me again.", embeds: [], components: [] });
      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ID.done).setLabel("I've Added It — Check Again").setStyle(ButtonStyle.Success)
      );
      try {
        await verifySuccess(row, { interaction: i });
      } catch (e) {
        if (!(e instanceof VerificationError)) throw e;
        if (e.message === "code-not-visible") {
          return i.update({
            embeds: [
              new EmbedBuilder()
                .setTitle("⏳ Not visible yet — hang tight")
                .setColor(0xfee75c)
                .setDescription(
                  `Roblox caches profiles, so your About can take **a minute or two** to update on their side.\n\n` +
                  `Keep \`${row.code}\` in your About — **no need to press anything**. I re-check every ${cfg.verify_poll_seconds}s and will complete automatically.` +
                  (row.roblox_username ? `` : "")
                ),
            ],
            components: [retryRow],
          });
        }
        return i.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("❌ Not yet")
              .setColor(0xed4245)
              .setDescription(e.message),
          ],
          components: [retryRow],
        });
      }
      return;
    }
  }

  async function handleModal(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const username = i.fields.getTextInputValue("username").trim();
    const user = await resolveUsername(username); // throws if not found
    const code = db.createCode(i.user.id, user.name, user.id);
    const headshot = await getHeadshotUrl(user.id);
    const embed = new EmbedBuilder()
      .setTitle("Is this the right account?")
      .setColor(0x5865f2)
      .setDescription("Your verification code will be linked to this Roblox account.")
      .addFields(
        { name: "Username", value: user.name, inline: true },
        { name: "Display name", value: user.displayName, inline: true },
        { name: "Profile", value: `roblox.com/users/${user.id}/profile`, inline: false }
      );
    if (headshot) embed.setThumbnail(headshot);
    return i.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(ID.yes).setLabel("Yes, that's me").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(ID.no).setLabel("No, wrong account").setStyle(ButtonStyle.Danger)
        ),
      ],
    });
  }

  // ------------------------------------------- screenshot OCR fallback --

  // ------------------------------------------------- inbox relay watcher --
  // An external notifier bot (invited into OUR guild, or a webhook feed)
  // posts its pings into a hidden inbox channel. We parse them and re-emit
  // through our own ping pipeline, in our design. Bots ARE read here on
  // purpose — the inbox exists to receive bot posts.
  const JOIN_LINK_RE = /roblox\.com\/games\/start\?placeId=(\d+)&gameInstanceId=([\w-]+)/i;

  const relayInbox = (message) => {
    const embeds = [...message.embeds.values()];
    // parse each source separately (concatenating lets egg names smear across fields)
    const sources = [];
    for (const e of embeds) {
      sources.push(e.description ?? "");
      for (const f of e.fields ?? []) sources.push(`${f.name} ${f.value}`);
      sources.push(e.title ?? "");
    }
    sources.push(message.content ?? "");
    const allText = sources.join(" ").replace(/\*/g, "");
    const link = allText.match(JOIN_LINK_RE);
    const jobId = link?.[2];

    let relayed = 0;
    for (const src of sources) {
      const text = src.replace(/\*/g, "");
      for (const spawn of parseBanners(text)) {
        const rowId = ingestSpawn(db, cfg, spawn, {
          server_id: jobId ?? null,
          source: "relay",
          spotter: message.author.username || "feed",
          fanoutFn: fanOut,
        });
        if (rowId !== null) {
          relayed++;
          console.log(`[relay] ${spawn.rarity} ${spawn.egg} (${spawn.biome})${jobId ? " +join link" : ""}`);
        }
      }
      if (relayed) break; // first source that parses cleanly is the canonical one
    }
    if (!relayed) {
      console.log("[relay] inbox post had no parseable spawn:", allText.slice(0, 80));
    }
  };

  client.on(Events.MessageCreate, async (message) => {
    // relay path first: inbox may contain bot posts
    if (cfg.inbox_channel_id && message.channel.id === String(cfg.inbox_channel_id)) {
      try {
        relayInbox(message);
      } catch (e) {
        console.error("[relay] failed:", e.message);
      }
      return;
    }

    if (message.author.bot) return;
    if (!cfg.screenshot_channel_id || message.channel.id !== String(cfg.screenshot_channel_id)) return;
    for (const att of message.attachments.values()) {
      if (!(att.contentType || "").startsWith("image/")) continue;
      try {
        const res = await fetch(att.url, { signal: AbortSignal.timeout(15000) });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = await ocr.imageBufferToText(buf);
        for (const spawn of parseBanners(text)) {
          const link = db.getLink(message.author.id);
          const spotter = link ? link.roblox_username : message.author.displayName;
          const rowId = ingestSpawn(db, cfg, spawn, {
            server_id: null, source: "screenshot", spotter, fanoutFn: fanOut,
          });
          if (rowId !== null) {
            await message.reply(`📥 Captured **${spawn.rarity} ${spawn.egg} Egg** in **${spawn.biome}** — credited to ${spotter}`);
          }
        }
      } catch (e) {
        console.error("[ocr] screenshot failed:", e.message);
      }
    }
  });

  return client;
}
