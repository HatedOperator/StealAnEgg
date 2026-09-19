// Spawn banner parser — ported 1:1 from the tested Python version.
// Banner shape: "A Eternal Oni Tiger Egg spawned in Cherry Blossom🌸!"

export const RARITIES = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary",
  "Mythic", "Secret", "Eternal", "Divine", "Cosmic",
];

export const RARITY_ORDER = Object.fromEntries(RARITIES.map((r, i) => [r.toLowerCase(), i]));

const BANNER_RE = new RegExp(
  `\\b(?<rarity>${RARITIES.join("|")})\\s+` +
  `(?<egg>[A-Za-z0-9][A-Za-z0-9'’\\- ]*?)\\s+` +
  `egg\\s+spawned\\s+in\\s+` +
  `(?<biome>[A-Za-z][A-Za-z0-9'’\\- ]*)`,
  "gi"
);

const title = (s) => s.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function parseBanners(text) {
  const cleaned = text.replace(/[^\x00-\x7F]+/g, " "); // strip emojis OCR trips on
  const out = [];
  for (const m of cleaned.matchAll(BANNER_RE)) {
    out.push({
      egg: title(m.groups.egg),
      rarity: m.groups.rarity[0].toUpperCase() + m.groups.rarity.slice(1).toLowerCase(),
      biome: title(m.groups.biome),
    });
  }
  return out;
}

export function rarityAtLeast(rarity, minimum) {
  const a = RARITY_ORDER[rarity.toLowerCase()];
  const b = RARITY_ORDER[minimum.toLowerCase()];
  return a !== undefined && b !== undefined && a >= b;
}
