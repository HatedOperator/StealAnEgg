// Spawn banner parser — ported 1:1 from the tested Python version.
// Banner shape: "A Eternal Oni Tiger Egg spawned in Cherry Blossom🌸!"

export const RARITIES = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary",
  "Mythic", "Secret", "Eternal", "Divine", "Cosmic", "Rift",
];

export const RARITY_ORDER = Object.fromEntries(RARITIES.map((r, i) => [r.toLowerCase(), i]));

const BANNER_RE = new RegExp(
  `\\b(?<rarity>${RARITIES.join("|")})\\s+` +
  `(?<egg>[A-Za-z0-9][A-Za-z0-9'’&\\- ]*?)\\s+` +
  `egg\\s+spawned\\s+in\\s+` +
  `(?<biome>[A-Za-z][A-Za-z0-9'’&\\- ]*)`,
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

// Second feed style seen in the wild: line-based fields with custom emojis —
//   "Egg: TRex"  /  "🦖Location: Prehistoric"  /  rarity word somewhere in text
export function parseFeedFormat(text) {
  const clean = text
    // expand custom emoji tags into their names: <:Secret_Egg:123> -> " Secret Egg "
    .replace(/<:([A-Za-z0-9_]+):\d+>/g, (_m, name) => ` ${name.replace(/_/g, " ")} `)
    .replace(/[^\x00-\x7F]+/g, " ");
  const egg = clean.match(/\bEgg:\s*([A-Za-z0-9][A-Za-z0-9'’\- ]*)/i)?.[1]?.trim();
  const biome = clean.match(/\bLocation:\s*([A-Za-z0-9][A-Za-z0-9'’&\- ]*)/i)?.[1]?.trim();
  if (!egg || !biome) return null;
  const rarityHit = RARITIES.find((r) => new RegExp(`\\b${r}\\b`, "i").test(clean));
  if (!rarityHit) return null;
  return { egg: title(egg), rarity: rarityHit, biome: title(biome) };
}
