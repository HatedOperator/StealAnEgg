// Admin Abuse + Update watcher — fully automated off public Roblox data.
//
//  - Update detection: place build number bumps -> announce in updates channel
//  - Admin Abuse: total concurrent players spiking over a rolling baseline
//    -> announce LIVE with a join link; plus a scheduled pre-event warning
//    (default Saturday 15:00 UTC = 11 AM ET, configurable)
import { EmbedBuilder } from "discord.js";
import { listServers } from "./roblox.js";

const FOOTER = "Alydex Group's | Steal An Egg Events & Notifier API";
const GAME_URL = (placeId) => `https://www.roblox.com/games/${placeId}/`;

export function startTelemetry(client, db, cfg) {
  if (!cfg.place_id) return console.warn("[telemetry] no place_id — watcher off");
  const updatesCh = () => channel(client, cfg.updates_channel_id);
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
      await checkVersion();
      await checkPlayers();
    } catch (e) {
      console.error("[telemetry]", e.message);
    }
  };

  // ------------------------------------------------------------ updates --

  async function checkVersion() {
    try {
      const res = await fetch(
        `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${cfg.place_id}`,
        { headers: { "User-Agent": "alydex-notifier/0.2" }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return;
      const detail = (await res.json())[0];
      const v = detail?.currentServerVersion;
      if (!v) return;
      const last = db.getSetting("last_build_version");
      if (last && last !== String(v)) {
        const ch = await updatesCh();
        if (ch) {
          await ch.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(`GAME UPDATED — build ${v}`)
                .setColor(0x57f287)
                .setDescription(
                  `Steal an Egg just shipped a new build (${last} → ${v}).\n` +
                  `> [**CLICK TO JOIN THE GAME**](${GAME_URL(cfg.place_id)})`
                )
                .setFooter({ text: FOOTER })
                .setTimestamp(),
            ],
          });
          console.log(`[telemetry] update announced: ${last} -> ${v}`);
        }
      }
      db.setSetting("last_build_version", String(v));
    } catch (e) {
      if (!String(e).includes("fetch failed")) console.error("[telemetry] version:", e.message);
    }
  }

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
    await ch.send({
      content: live && roleId ? `<@&${roleId}>` : "",
      embeds: [
        new EmbedBuilder()
          .setTitle(live ? "ADMIN ABUSE IS LIVE" : "Admin Abuse has ended")
          .setColor(live ? 0xed4245 : 0x99aab5)
          .setDescription(
            live
              ? `Player count just jumped **${Math.round((players / median) * 100 - 100)}%** above normal ` +
                `(${players.toLocaleString("en-US")} playing right now).\n` +
                `> [**CLICK TO JOIN THE ACTION**](${join})`
              : `Activity is back to normal (${players.toLocaleString("en-US")} playing).`
          )
          .setFooter({ text: FOOTER })
          .setTimestamp(),
      ],
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
      await ch.send({
        content: roleId ? `<@&${roleId}>` : "",
        embeds: [
          new EmbedBuilder()
            .setTitle("Admin Abuse starting soon")
            .setColor(0xfee75c)
            .setDescription(
              `The weekly Admin Abuse event typically kicks off around now.\n` +
              `Rare eggs, boosted spawns — get in position.\n` +
              `> [**CLICK TO JOIN THE GAME**](${GAME_URL(cfg.place_id)})`
            )
            .setFooter({ text: FOOTER })
            .setTimestamp(),
        ],
      });
      console.log("[telemetry] weekly abuse warning sent");
    } catch (e) {
      console.error("[telemetry] warn:", e.message);
    }
  }, 60_000);

  // ------------------------------------------------------ event pages -----
  // Roblox event pages expose no public schedule API — but the og meta tags
  // change when a new event goes live or moves phase. Watch them.
  async function checkEvents() {
    for (const id of cfg.event_ids ?? []) {
      try {
        const res = await fetch(`https://www.roblox.com/events/${id}`, {
          headers: { "User-Agent": "Mozilla/5.0 (alydex-notifier)" },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const html = await res.text();
        const snap = {
          title: html.match(/og:title" content="([^"]*)"/)?.[1]?.replace(/&#x[0-9A-Fa-f]+;/g, " ") ?? "",
          desc: html.match(/og:description" content="([^"]*)"/)?.[1]?.replace(/&#x[0-9A-Fa-f]+;/g, " ").slice(0, 300) ?? "",
          image: html.match(/og:image" content="([^"]*)"/)?.[1] ?? "",
        };
        const key = `event_snap_${id}`;
        const prev = db.getSetting(key);
        if (prev && prev !== JSON.stringify(snap) && snap.title) {
          const ch = await updatesCh();
          if (ch) {
            const roleId = cfg.updates_role || 0;
            await ch.send({
              content: roleId ? `<@&${roleId}>` : "",
              embeds: [
                new EmbedBuilder()
                  .setTitle(snap.title.slice(0, 250))
                  .setColor(0x5865f2)
                  .setDescription(
                    `${snap.desc}\n\n> [**OPEN THE EVENT PAGE**](https://www.roblox.com/events/${id})`
                  )
                  .setImage(snap.image)
                  .setFooter({ text: FOOTER })
                  .setTimestamp(),
              ],
            });
            console.log(`[telemetry] event page changed: ${id} -> ${snap.title.slice(0, 50)}`);
          }
        }
        if (snap.title) db.setSetting(key, JSON.stringify(snap));
      } catch (e) {
        console.error(`[telemetry] event ${id}:`, e.message);
      }
    }
  }

  poll();
  checkEvents(); // baseline snapshot on boot
  setInterval(poll, 60_000);
  setInterval(checkEvents, 5 * 60_000); // event pages: lighter touch
  console.log("[telemetry] watching for updates + admin abuse");
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
