// Core logic shared by bot + API: verification checks, capture ingest, fan-out.
import { rarityAtLeast } from "./banner.js";
import { getProfile } from "./roblox.js";
import { anchorFromTimestamp } from "./predictor.js";

export class VerificationError extends Error {}

export function joinLink(cfg, serverId) {
  if (!cfg.place_id || !serverId) return null;
  return `https://www.roblox.com/games/start?placeId=${cfg.place_id}&gameInstanceId=${serverId}`;
}

// ----------------------------------------------------------- verification --

export async function checkCodeRow(db, codeRow, ttlMinutes = 30) {
  const age = Date.now() / 1000 - codeRow.created_at;
  if (age > ttlMinutes * 60) throw new VerificationError("Code expired — start verification again.");

  const userId = codeRow.roblox_user_id;
  if (!userId) throw new VerificationError("No Roblox account attached — start verification again.");
  const profile = await getProfile(userId);
  const about = profile.description || "";
  if (!about.includes(codeRow.code)) {
    throw new VerificationError(
      `Couldn't find code \`${codeRow.code}\` in ${codeRow.roblox_username}'s About. Save it at roblox.com → Settings → About, then hit Check.`
    );
  }
  db.completeCode(codeRow, userId);
  return { roblox_user_id: userId, roblox_username: codeRow.roblox_username };
}

// ---------------------------------------------------------------- ingest --

export function ingestSpawn(db, cfg, spawn, { server_id = null, source, spotter = null, fanoutFn }) {
  const rowId = db.insertCapture({
    egg: spawn.egg, rarity: spawn.rarity, biome: spawn.biome,
    server_id, source, spotter, cycle_seconds: cfg.cycle_seconds,
  });
  if (rowId === null) return null; // duplicate

  if (db.getSetting("cycle_epoch") === null) {
    db.setSetting("cycle_epoch", String(anchorFromTimestamp(Date.now() / 1000, cfg.cycle_seconds)));
  }

  if (rarityAtLeast(spawn.rarity, cfg.min_rarity_to_ping)) {
    try {
      fanoutFn(cfg, spawn, server_id, spotter, source);
    } catch (e) {
      console.error("[fanout] failed:", e.message);
    }
  }
  return rowId;
}

// ---------------------------------------------------------------- fanout --

export async function fanOut(cfg, spawn, serverId, spotter, source) {
  const url = cfg.notify_webhook_url;
  if (!url || url.includes("xxxx")) {
    console.log(`[fanout] no webhook configured; would ping ${spawn.rarity} ${spawn.egg}`);
    return;
  }
  const roleId = (cfg.ping_roles || {})[spawn.rarity.toLowerCase()] || 0;
  const link = joinLink(cfg, serverId);
  const desc = [
    `**${spawn.rarity} ${spawn.egg} Egg** spawned in **${spawn.biome}**`,
    ...(link ? [`🔗 [**JOIN SERVER**](${link})`] : []),
    ...(spotter ? [`*spotted by ${spotter} (${source})*`] : []),
  ].join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: roleId ? `<@&${roleId}> ` : "",
      embeds: [{
        title: `🥚 ${spawn.rarity} Egg — ${spawn.egg}`,
        description: desc,
        color: 0x9b59b6,
        footer: { text: "steal-an-egg notifier" },
      }],
    }),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}
