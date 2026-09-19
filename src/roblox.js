// Public Roblox web API client (no auth, no cookies — public data only).
const UA = { "User-Agent": "steal-an-egg-notifier/0.2 (community tool)" };

export class RobloxError extends Error {}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(8000), // never let a Roblox call hang a modal
    headers: { ...UA, ...(opts.headers || {}) },
  });
  if (res.status === 429) throw new RobloxError("Rate limited by Roblox — back off");
  if (!res.ok) throw new RobloxError(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function resolveUsername(username) {
  const data = await jfetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username] }),
  });
  if (!data.data?.length) throw new RobloxError(`No Roblox user named "${username}"`);
  return data.data[0]; // { id, name, displayName }
}

export async function getProfile(userId) {
  return jfetch(`https://users.roblox.com/v1/users/${userId}`); // includes .description
}

// The users API's description field can be stale or flat-out empty even when
// the blurb is saved — the live profile page (og:description) carries the
// real About text, appended after the boilerplate sentence.
export async function getProfilePageBlurb(userId) {
  try {
    const res = await fetch(`https://www.roblox.com/users/${userId}/profile`, {
      headers: { "User-Agent": "Mozilla/5.0 (steal-an-egg-notifier verification)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    return html.match(/property="og:description" content="([^"]*)"/)?.[1] || "";
  } catch {
    return "";
  }
}

export async function getHeadshotUrl(userId) {
  try {
    const data = await jfetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=png`
    );
    return data.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

export async function listServers(placeId, sortOrder = 2) {
  const data = await jfetch(
    `https://games.roblox.com/v1/games/${placeId}/servers/0?sortOrder=${sortOrder}&limit=100`
  );
  return data.data || [];
}
