// Cycle timer + calibrated odds (weather-style: exact clock, honest dice).
export function anchorFromTimestamp(ts, cycleSeconds = 300) {
  return ts - (ts % cycleSeconds);
}

export function nextReset({ now = Date.now() / 1000, epoch = null, cycleSeconds = 300 } = {}) {
  if (epoch === null || epoch === undefined) {
    const elapsed = now % cycleSeconds;
    return { nextResetIn: cycleSeconds - elapsed, cycleNumber: 0, anchored: false };
  }
  const elapsed = now - epoch;
  return {
    nextResetIn: cycleSeconds - (elapsed % cycleSeconds),
    cycleNumber: Math.floor(elapsed / cycleSeconds) + 1,
    anchored: true,
  };
}

export function countdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function oddsText(odds) {
  const lines = [];
  for (const rarity of Object.keys(odds).sort((a, b) => odds[b] - odds[a])) {
    const p = odds[rarity];
    if (p >= 0.001) {
      lines.push(`**${title(rarity)}** ~${+(p * 100)}% per cycle`);
    } else {
      lines.push(`**${title(rarity)}** ~1 in ${Math.round(1 / p).toLocaleString("en-US")} cycles`);
    }
  }
  return lines.join("\n");
}

const title = (s) => s[0].toUpperCase() + s.slice(1);
