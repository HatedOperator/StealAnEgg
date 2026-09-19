// Admin Abuse watcher — fully automated off public Roblox data.
//
// Total concurrent players spiking over a rolling baseline -> announce LIVE
// with a join link; plus a scheduled pre-event warning (default Saturday
// 15:00 UTC = 11 AM ET, configurable). Updates are handled manually.
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { listServers } from "./roblox.js";

const FOOTER = "Alydex Group's | Steal An Egg Events & Notifier API";
const FOOTER_SAE = "Steal An Egg Events & Notifier API";
const GAME_URL = (placeId) => `https://www.roblox.com/games/${placeId}/`;

export function startTelemetry(client, db, cfg) {
  if (!cfg.place_id) return console.warn("[telemetry] no place_id — watcher off");
  const abuseCh = () => channel(client, cfg.admin_abuse_channel_id);

  // rolling player samples: [{ts, players}]
  const samples = [];
  let abuseActive = false;
  let spikeStreak = 0;
  let calmStreak = 0;
  let cooldownUntil = 0;
  let lastPersist = 0;
  let session = null; // {start, baseline, peak, peakTs} — real-event curve capture

  const poll = async () => {
    try {
      await checkPlayers();
    } catch (e) {
      console.error("[telemetry]", e.message);
    }
  };

  // -------------------------------------------------------- admin abuse --

  async function checkPlayers() {
    const servers = await listServers(cfg.place_id).catch(() => []);
    if (!servers.length) return;
    const players = servers.reduce((n, s) => n + (s.playing ?? 0), 0);
    const now = Date.now() / 1000;
    samples.push({ ts: now, players });
    while (samples.length && now - samples[0].ts > 90 * 60) samples.shift();

    // baseline = samples between 10 and 60 minutes old (skips the spike itself)
    const base = samples.filter((s) => now - s.ts > 600 && now - s.ts < 3600);
    if (base.length < 5) return;
    const sorted = base.map((s) => s.players).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!median) return;

    const ratio = players / median;

    // history for future calibration: dense during events, sparse otherwise
    if (ratio >= 1.2 || now - lastPersist > 600) {
      db.conn.prepare("INSERT INTO player_history(ts, players) VALUES(?,?)").run(now, players);
      lastPersist = now;
    }
    if (session) {
      if (players > session.peak) session = { ...session, peak: players, peakTs: now };
    }

    if (!abuseActive && now > cooldownUntil) {
      spikeStreak = ratio >= 1.35 ? spikeStreak + 1 : 0;
      if (spikeStreak >= 2) {
        abuseActive = true;
        spikeStreak = calmStreak = 0;
        session = { start: now, baseline: median, peak: players, peakTs: now };
        await announceAbuse(true, players, median, servers);
      }
    } else if (abuseActive) {
      calmStreak = ratio < 1.15 ? calmStreak + 1 : 0;
      if (calmStreak >= 5) {
        abuseActive = false;
        cooldownUntil = now + 45 * 60;
        await announceAbuse(false, players, median, servers);
        if (session) {
          const mins = Math.round((now - session.start) / 60);
          const ch = await abuseCh();
          if (ch) {
            await ch.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle("Session report")
                  .setColor(0x5865f2)
                  .setDescription(
                    `**Duration:** ~${mins} min
` +
                    `**Peak players:** ${session.peak.toLocaleString("en-US")} ` +
                    `(**${(session.peak / session.baseline).toFixed(1)}x** normal, ` +
                    `hit <t:${Math.floor(session.peakTs)}:R>)
` +
                    `**Baseline:** ${session.baseline.toLocaleString("en-US")}`
                  )
                  .setFooter({ text: FOOTER })
                  .setTimestamp(),
              ],
            });
          }
          db.setSetting("last_abuse_session", JSON.stringify({ ...session, end: now, mins }));
          console.log(`[telemetry] session recorded: peak ${session.peak} (${(session.peak / session.baseline).toFixed(1)}x, ${mins}min)`);
          session = null;
        }
      }
    }
  }

  async function announceAbuse(live, players, median, servers) {
    const ch = await abuseCh();
    if (!ch) return;
    // deepest server = most likely where the action is
    const busiest = [...servers].sort((a, b) => (b.playing ?? 0) - (a.playing ?? 0))[0];
    const join = busiest?.id
      ? `https://www.roblox.com/games/start?placeId=${cfg.place_id}&gameInstanceId=${busiest.id}`
      : GAME_URL(cfg.place_id);
    const roleId = cfg.admin_abuse_role || 0;

    // the live post replaces the warning — delete it so the channel tells one story
    if (live) {
      const warnId = db.getSetting("abuse_warning_msg_id");
      if (warnId) {
        db.setSetting("abuse_warning_msg_id", "");
        try {
          const warn = await ch.messages.fetch(warnId);
          await warn.delete();
          console.log("[telemetry] warning deleted (replaced by LIVE)");
        } catch { /* already gone */ }
      }
    }

    await ch.send({
      content: live && roleId ? `<@&${roleId}>` : "",
      embeds: [
        new EmbedBuilder()
          .setTitle(live ? "ADMIN ABUSE — LIVE NOW" : "Admin Abuse has ended")
          .setColor(live ? 0xed4245 : 0x99aab5)
          .setDescription(
            live
              ? "Admin Abuse is happening **RIGHT NOW** in Steal an Egg.\n" +
                "Join up for chaos, special admin events, random rewards and things you normally won't see during regular gameplay.\n\n" +
                "• **Special admin events**\n" +
                "• **Random rewards & surprises**\n" +
                "• **Admin commands / chaos**\n" +
                "• **Join before it ends**"
              : `It's over — the update is about to drop. Next abuse lands next Saturday, warning ping comes first.`
          )
          .setFooter({ text: live ? FOOTER_SAE : FOOTER })
          .setTimestamp(),
      ],
      components: live
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setURL(join).setLabel("JOIN ADMIN ABUSE!").setStyle(ButtonStyle.Link)
            ),
          ]
        : [],
    });
    console.log(`[telemetry] abuse ${live ? "LIVE" : "ended"} (${players} players, baseline ${median})`);
  }

  // ------------------------------------------- scheduled weekly warning --

  const warnMinuteOfDay = (cfg.admin_abuse_utc_hour ?? 15) * 60 - (cfg.admin_abuse_warn_minutes ?? 15);
  setInterval(async () => {
    try {
      const now = new Date();
      if (now.getUTCDay() !== (cfg.admin_abuse_day ?? 6)) return; // 6 = Saturday
      const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (mins < warnMinuteOfDay || mins > warnMinuteOfDay + 10) return;
      const weekKey = now.toISOString().slice(0, 10);
      if (db.getSetting("last_abuse_warn") === weekKey) return;
      db.setSetting("last_abuse_warn", weekKey);
      const ch = await abuseCh();
      if (!ch) return;
      const roleId = cfg.admin_abuse_role || 0;
      const sent = await ch.send({
        content: roleId ? `<@&${roleId}>` : "",
        embeds: [
          new EmbedBuilder()
            .setTitle("Admin Abuse starting soon")
            .setColor(0xfee75c)
            .setDescription(
              "Admin Abuse is happening **VERY SOON** in Steal an Egg.\n" +
              "Join up for chaos, special admin events, random rewards and things you normally won't see during regular gameplay."
            )
            .setFooter({ text: FOOTER_SAE })
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setURL(GAME_URL(cfg.place_id)).setLabel("JOIN ADMIN ABUSE!").setStyle(ButtonStyle.Link)
          ),
        ],
      });
      db.setSetting("abuse_warning_msg_id", sent.id); // deleted when LIVE fires
      console.log("[telemetry] weekly abuse warning sent");
    } catch (e) {
      console.error("[telemetry] warn:", e.message);
    }
  }, 60_000);

  poll();
  setInterval(poll, 60_000);
  console.log("[telemetry] watching for admin abuse");
}

async function channel(client, id) {
  if (!id) return null;
  try {
    const ch = await client.channels.fetch(String(id));
    return ch?.send ? ch : null;
  } catch {
    return null;
  }
}
