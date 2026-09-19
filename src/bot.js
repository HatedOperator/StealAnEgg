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
import { parseBanners, parseFeedFormat, RARITIES } from "./banner.js";
import { nextReset, oddsText } from "./predictor.js";
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
    try {
      await ensurePanel();
    } catch (e) {
      console.error("[panel] startup failed (does not affect relays):", e.message);
    }
    setInterval(pollPending, cfg.verify_poll_seconds * 1000);

    // Poll the last-seen inbox (pollLastSeen defined near mirrorBoard below)
    await pollLastSeen();
    setInterval(pollLastSeen, 60_000);
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
      const gate = cfg.predict_role_id;
      if (gate && !i.member?.roles?.cache?.has(String(gate))) {
        return i.reply({
          content: "Predictions are for prediction-whitelisted members only.",
          flags: MessageFlags.Ephemeral,
        });
      }
      const epoch = db.getSetting("cycle_epoch");
      const p = nextReset({ epoch: epoch ? Number(epoch) : null, cycleSeconds: cfg.cycle_seconds });
      const anchorNote = p.anchored ? "" : "\n*(calibrates after the first real capture)*";
      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⏱ Next egg reset")
            .setColor(0xfee75c)
            .setDescription(
              `**Reset in <t:${Math.floor(Date.now() / 1000 + p.nextResetIn)}:R>** (cycle #${p.cycleNumber})${anchorNote}\n\n` +
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
  // External notifier feeds land in hidden inbox channels. We parse them,
  // ingest (dedupe + stats), and re-emit in OUR design into the matching
  // output channel. Bots ARE read here on purpose — inboxes receive bot posts.
  const JOIN_LINK_RE = /(https:\/\/www\.roblox\.com\/games\/start\?placeId=\d+&(?:gameInstanceId|gameId)=[\w-]+)/i;

  const stripEmojis = (t) =>
    (t ?? "")
      .replace(/<a?:[A-Za-z0-9_]+:\d+>/g, "")                    // custom discord emojis (static + animated)
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "") // unicode emojis
      .replace(/[ \t]{2,}/g, " ")
      .trim();

  const headerImage = (e) => e?.thumbnail?.url || e?.image?.url || null;

  // pull his data lines (Money / Speed / spawn time) out of description text
  const intelFields = (text) => {
    const t = text ?? "";
    const out = [];
    const money = t.match(/Money:\s*([^<\n]+)/i)?.[1]?.trim();
    const speed = t.match(/Recommended Speed:\s*([^<\n]+)/i)?.[1]?.trim();
    const ts = t.match(/<t:\d+:R>/)?.[0]; // discord relative timestamp renders live
    if (money) out.push({ name: "Money", value: stripEmojis(money), inline: true });
    if (speed) out.push({ name: "Speed Needed", value: stripEmojis(speed), inline: true });
    if (ts) out.push({ name: "Spawned", value: ts, inline: true });
    return out;
  };

  const RARITY_COLORS = {
    common: 0x99aab5, uncommon: 0x57f287, rare: 0x3498db, epic: 0x9b59b6,
    legendary: 0xf1c40f, mythic: 0xe67e22, secret: 0x2b2d31, eternal: 0xe91e8c,
    divine: 0xffd700, cosmic: 0x00d4ff, rift: 0x7c3aed,
  };

  const collectEmbedTexts = (message) => {
    const sources = [];
    for (const e of [...message.embeds.values()]) {
      sources.push(e.description ?? "");
      for (const f of e.fields ?? []) sources.push(`${f.name} ${f.value}`);
      sources.push(e.title ?? "");
    }
    sources.push(message.content ?? "");
    return sources;
  };

  // preserve his extra intel (money, speed gates, mutations...) in our layout
  const passthroughFields = (message) => {
    const KNOWN = /egg|spawn|join|biome|server|link|rarity/i;
    const out = [];
    for (const e of [...message.embeds.values()]) {
      for (const f of e.fields ?? []) {
        if (KNOWN.test(f.name)) continue;
        out.push({ name: stripEmojis(f.name) || "—", value: stripEmojis(f.value) || "—", inline: f.inline ?? true });
      }
    }
    return out.slice(0, 8);
  };

  const postOurs = async (message, type, spawn, jobId, joinUrl = null) => {
    const outId = type === "lastseen" ? cfg.lastseen_output_channel_id : cfg.notifier_output_channel_id;
    if (!outId) return;
    try {
      const ch = await client.channels.fetch(String(outId));
      if (!ch) return;
      const color = RARITY_COLORS[spawn.rarity.toLowerCase()] ?? 0x9b59b6;
      // prefer his exact link (gameId= style works too); else construct one
      const join = joinUrl
        ?? (jobId ? `https://www.roblox.com/games/start?placeId=${cfg.place_id || "PLACE"}&gameInstanceId=${jobId}` : null);
      const isLastSeen = type === "lastseen";
      const embed = new EmbedBuilder()
        .setTitle(isLastSeen ? `LAST SEEN — ${spawn.rarity} ${spawn.egg}` : `${spawn.rarity} EGG IS LIVE — ${spawn.egg}`)
        .setColor(color)
        .setDescription(
          `**${spawn.rarity} ${spawn.egg} Egg** — **${spawn.biome}**
` +
          (join ? `> [**CLICK TO JOIN THE SERVER**](${join})` : "")
        )
        .addFields(...(() => {
          const intel = intelFields([...message.embeds.values()].map((e) => `${e.description ?? ""}\n${e.title ?? ""}`).join("\n") + " " + (message.content ?? ""));
          const extra = passthroughFields(message);
          const all = [...extra, ...intel];
          return all.length ? all : [{ name: "​", value: "​" }];
        })())
        .setFooter({ text: "Alydex Group's | Steal An Egg Events & Notifier API" })
        .setTimestamp();
      const roleId = isLastSeen ? 0 : (cfg.ping_roles || {})[spawn.rarity.toLowerCase()] || 0;
      await ch.send({ content: roleId ? `<@&${roleId}>` : "", embeds: [embed] });
    } catch (e) {
      console.error("[relay] post failed:", e.message);
    }
  };

  const relayInbox = async (message, type, { silent = false } = {}) => {
    const sources = collectEmbedTexts(message);
    const allText = sources.join(" ").replace(/\*/g, "");
    const linkMatch = allText.match(JOIN_LINK_RE);
    const jobId = linkMatch?.[1];
    const joinUrl = linkMatch?.[0];

    let parsedAny = 0;
    let relayed = 0;
    const trySpawn = async (spawn) => {
      parsedAny++;
      const rowId = ingestSpawn(db, cfg, spawn, {
        server_id: jobId ?? null,
        source: type === "lastseen" ? "lastseen" : "relay",
        spotter: message.author.username || "feed",
        fanoutFn: fanOut,
      });
      if (rowId !== null) {
        relayed++;
        console.log(`[relay:${type}] ${spawn.rarity} ${spawn.egg} (${spawn.biome})${jobId ? " +join link" : ""}`);
        if (!silent) await postOurs(message, type, spawn, jobId, joinUrl);
      }
    };
    for (const src of sources) {
      const text = src.replace(/\*/g, "");
      for (const spawn of parseBanners(text)) {
        await trySpawn(spawn);
      }
      if (!parsedAny) {
        const feedSpawn = parseFeedFormat(src);
        if (feedSpawn) await trySpawn(feedSpawn);
      }
      if (parsedAny) break; // first source that parses cleanly is the canonical one
    }
    if (parsedAny && !relayed) {
      console.log(`[relay:${type}] duplicate — already posted, skipping`);
      return;
    }
    if (!parsedAny) {
      // Unknown format: still relay like-for-like (re-styled) so nothing is lost.
      if (silent) return;
      console.log(`[relay:${type}] unparsed format — restyling raw:`, allText.slice(0, 400));
      const firstEmbed = [...message.embeds.values()][0];
      if (firstEmbed) {
        const outId = type === "lastseen" ? cfg.lastseen_output_channel_id : cfg.notifier_output_channel_id;
        try {
          const ch = outId && (await client.channels.fetch(String(outId)));
          if (ch) {
            // ping the matching role even when the format went unparsed
            const fbText = `${firstEmbed.title ?? ""} ${firstEmbed.description ?? ""}`
              .replace(/<:([A-Za-z0-9_]+):\d+>/g, (_m, n) => ` ${n.replace(/_/g, " ")} `);
            const fbRarity = [...RARITIES].reverse().find((r) => new RegExp(`\\b${r}\\b`, "i").test(fbText));
            const fbRoleId = (cfg.ping_roles || {})[(fbRarity || "").toLowerCase()] || 0;
            await ch.send({
              content: type === "lastseen" ? "" : fbRoleId ? `<@&${fbRoleId}>` : "",
              embeds: [(() => {
                const b = new EmbedBuilder()
                  .setTitle(stripEmojis(firstEmbed.title) || "Feed update")
                  .setColor(type === "lastseen" ? 0x5865f2 : 0x9b59b6)
                  .setDescription(stripEmojis(firstEmbed.description))
                  .addFields(...(firstEmbed.fields ?? []).slice(0, 8).map((f) => ({ name: stripEmojis(f.name) || "—", value: stripEmojis(f.value) || "—", inline: f.inline ?? true })))
                  .setFooter({ text: "Alydex Group's | Steal An Egg Events & Notifier API" })
                  .setTimestamp();
                if (type === "lastseen") {
                  const img = headerImage(firstEmbed);
                  if (img) b.setThumbnail(img);
                }
                return b;
              })()],
            });
          }
        } catch (e) {
          console.error("[relay] raw post failed:", e.message);
        }
      }
    }
  };

  // ------------------------------------------------- last-seen board mirror --
  // His last-seen bot keeps ONE message and edits it forever (never resends).
  // We keep our own message in the output channel and edit it in sync.
  const mirrorHashes = new Map(); // their message id -> last content snapshot
  let lastSeenScans = 0;

  const mirrorPayload = (message) => {
    const embeds = [...message.embeds.values()];
    const restyled = embeds.map((e) => {
      const b = new EmbedBuilder()
        .setTitle(stripEmojis(e.title) || "Last Seen")
        .setColor(0x5865f2)
        .setDescription(stripEmojis(e.description))
        .addFields(...(e.fields ?? []).slice(0, 8).map((f) => ({ name: stripEmojis(f.name) || "—", value: stripEmojis(f.value) || "—", inline: f.inline ?? true })))
        .setFooter({ text: "Alydex Group's | Steal An Egg Events & Notifier API" })
        .setTimestamp();
      const img = headerImage(e);
      if (img) b.setThumbnail(img);
      if (e.image?.url) b.setImage(e.image.url);
      return b;
    });

    // image-only boards: his bot posts a generated PNG with no embed/text
    const images = [...message.attachments.values()].filter((a) => (a.contentType ?? "").startsWith("image/"));
    if (!restyled.length && images.length) {
      return {
        embeds: [new EmbedBuilder()
          .setTitle("Last Seen")
          .setColor(0x5865f2)
          .setImage(images[0].url)
          .setFooter({ text: "Alydex Group's | Steal An Egg Events & Notifier API" })
          .setTimestamp()],
      };
    }

    if (restyled.length) return { embeds: restyled };
    const text = stripEmojis(message.content);
    return text
      ? { embeds: [new EmbedBuilder().setTitle("Last Seen").setColor(0x5865f2).setDescription(text).setFooter({ text: "Alydex Group's | Steal An Egg Events & Notifier API" }).setTimestamp()] }
      : null;
  };;

  // Components V2 boards (SenZ-style): all text lives in the component tree
  // (type 17 containers / type 10 text displays), not in content or embeds.
  const collectComponentText = (comps, out = []) => {
    for (const c of comps ?? []) {
      if (c.content) out.push(c.content);
      if (c.components) collectComponentText(c.components, out);
      if (c.items) collectComponentText(c.items, out);
      if (c.accessory) collectComponentText([c.accessory], out);
    }
    return out;
  };
  const collectComponentMedia = (comps, out = []) => {
    for (const c of comps ?? []) {
      if (c.media?.url) out.push(c.media.url);
      if (c.accessory?.media?.url) out.push(c.accessory.media.url);
      if (c.url && /https?:\/\//.test(c.url) && !/discord\.com/.test(c.url)) out.push(c.url);
      if (c.components) collectComponentMedia(c.components, out);
      if (c.items) collectComponentMedia(c.items, out);
    }
    return out;
  };

  const mirrorBoard = async (message) => {
    const outId = cfg.lastseen_output_channel_id;
    if (!outId) return;
    let payload = mirrorPayload(message);
    if (!payload) {
      // fall back to the raw component tree via REST
      try {
        const raw = await client.rest.get(`/channels/${message.channelId}/messages/${message.id}`);
        const texts = collectComponentText(raw.components);
        // his footer carries the real "Updated <t:..:R>" stamp — use it for ours
        const updatedTs = texts.join("\n").match(/Updated <t:(\d+):R>/i)?.[1]
          ?? Math.floor(Date.now() / 1000);
        // rebuild his layout cleanly: bold rarity section headers, one egg per
        // line as "Name — time (· biome)", live <t:..:R> timestamps kept
        const sections = [];
        for (const t of texts) {
          const lines = t.split("\n")
            .map((l) => stripEmojis(l.replace(/^#+\s*/, "").replace(/^-#\s*/, "")).replace(/\s+/g, " ").trim())
            .filter((l) => l && !/senz|add me to your server/i.test(l)); // drop his branding
          if (!lines.length) continue;
          const header = lines[0].toUpperCase();
          const entries = lines.slice(1)
            .map((l) => {
              const idx = l.indexOf("—");
              if (idx === -1) return l;
              return `**${l.slice(0, idx).trim()}** — ${l.slice(idx + 1).trim()}`;
            });
          if (/last seen|active/i.test(header)) {
            sections.push({ header, entries });
          } else if (entries.length) {
            sections.push({ header: "LAST SEEN", entries: [header, ...entries] });
          }
        }
        // one embed per rarity section, e.g. title "DIVINE LAST SEEN"
        const sectionEmbeds = sections
          .filter((s) => s.entries.length)
          .slice(0, 10)
          .map((s) => {
            const label = s.header.replace(/\s*[—-]\s*LAST SEEN/i, "").replace(/\s*LAST SEEN/i, "").trim();
            const isRaritySection = /LAST SEEN/i.test(s.header);
            const b = new EmbedBuilder()
              .setTitle(isRaritySection ? `${label} LAST SEEN` : s.header)
              .setColor(RARITY_COLORS[label.toLowerCase()] ?? 0x5865f2)
              .setDescription(s.entries.join("\n").slice(0, 4000))
              .setFooter({ text: "Alydex Group's | Steal An Egg Events & Notifier API" })
              .setTimestamp();
            return b;
          });
        if (sectionEmbeds.length) {
          const media = collectComponentMedia(raw.components)[0];
          if (media) sectionEmbeds[0].setImage(media);
          // live-ticking freshness line at the bottom of the board (footers are
          // plain text and can't render timestamps)
          const last = sectionEmbeds[sectionEmbeds.length - 1];
          last.data.description = `${last.data.description}\n\n**__LAST UPDATED <t:${updatedTs}:R>__**`.slice(0, 4000);
          payload = { embeds: sectionEmbeds };
        }
      } catch (e) {
        console.error("[mirror] raw component fetch failed:", e.message);
      }
    }
    if (!payload) {
      const atts = [...message.attachments.values()];
      console.log(`[mirror] no mirrorable content on ${message.id} (embeds=${message.embeds?.size ?? 0}, attachments=${atts.length})`);
      return;
    }
    // compare everything EXCEPT the timestamp, or every build looks "changed"
    const snapshot = JSON.stringify(payload.embeds.map((e) => {
      const { timestamp: _ts, ...rest } = e.data;
      return rest;
    }));
    if (mirrorHashes.get(message.id) === snapshot) return; // nothing changed
    mirrorHashes.set(message.id, snapshot);

    const ch = await client.channels.fetch(String(outId));
    if (!ch) return;
    const mineId = db.getSetting(`lastseen_mirror_${message.id}`);
    if (mineId) {
      try {
        const mine = await ch.messages.fetch(mineId);
        console.log("[mirror] detected changes, editing last seen message");
        await mine.edit(payload);
        return;
      } catch { /* deleted — resend below */ }
    }
    console.log("[mirror] sending updated last seen");
    const sent = await ch.send(payload);
    db.setSetting(`lastseen_mirror_${message.id}`, sent.id);
  };

  // Poll the last-seen inbox: his board is one message edited forever, so
  // events alone are unreliable — scan on startup and every minute.
  const pollLastSeen = async () => {
    try {
      if (!cfg.lastseen_channel_id) return console.log("[mirror] poll skipped: no lastseen_channel_id");
      console.log(lastSeenScans++ === 0 ? "[mirror] scanning last seen" : "[mirror] rescanning last seen");
      const ch = await client.channels.fetch(String(cfg.lastseen_channel_id));
      if (!ch) return console.log("[mirror] poll: channel fetch returned null");
      if (!ch.messages) return console.log(`[mirror] poll: channel type ${ch.type} has no messages API`);

      const targets = [ch];
      // boards sometimes live in forum posts / threads — poll those too
      try {
        if (ch.threads) {
          const active = await ch.threads.fetchActive();
          for (const t of active.threads.values()) targets.push(t);
          const archived = await ch.threads.fetchArchived();
          for (const t of archived.threads.values()) targets.push(t);
        }
      } catch { /* not a forum */ }

      let seen = 0;
      for (const target of targets) {
        const msgs = await target.messages.fetch({ limit: 10 });
        for (const m of [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
          if (m.author?.id === client.user?.id) continue;
          if (m.author?.bot) seen++;
          await relayInbox(m, "lastseen", { silent: true });
          await mirrorBoard(m);
        }
      }
      console.log(`[mirror] poll done: ${targets.length} target(s), ${seen} bot message(s)`);
    } catch (e) {
      console.error("[mirror] poll failed:", e.message);
    }
  };;
  client.pollLastSeen = pollLastSeen; // exposed for testing
  // (startup call + interval live in the ready handler)

  client.on(Events.MessageUpdate, async (_oldMsg, newMsg) => {
    try {
      if (!cfg.lastseen_channel_id || newMsg.channel?.id !== String(cfg.lastseen_channel_id)) return;
      if (newMsg.author?.id === client.user?.id) return;
      // partial updates lack embeds/content — fetch the full message
      const full = newMsg.partial ? await newMsg.fetch() : newMsg;
      await mirrorBoard(full);
      // silently keep spawn stats fresh too
      for (const src of collectEmbedTexts(full)) {
        const jobId = src.match(JOIN_LINK_RE)?.[2];
        for (const spawn of parseBanners(src.replace(/\*/g, ""))) {
          ingestSpawn(db, cfg, spawn, {
            server_id: jobId ?? null, source: "lastseen",
            spotter: full.author?.username || "feed", fanoutFn: fanOut,
          });
        }
      }
    } catch (e) {
      console.error("[mirror] update failed:", e.message);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // relay path first: inboxes may contain bot posts
    if (message.author?.id === client.user?.id) return; // never relay ourselves (loop guard)
    if (cfg.inbox_channel_id && message.channel.id === String(cfg.inbox_channel_id)) {
      await relayInbox(message, "notifier").catch((e) => console.error("[relay] failed:", e.message));
      return;
    }
    if (cfg.lastseen_channel_id && message.channel.id === String(cfg.lastseen_channel_id)) {
      // board feed: stats ingest only — the mirror handles all output
      await relayInbox(message, "lastseen", { silent: true }).catch((e) => console.error("[relay] failed:", e.message));
      await mirrorBoard(message).catch((e) => console.error("[mirror] failed:", e.message));
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
