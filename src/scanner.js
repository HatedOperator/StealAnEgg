// Member-side scanner (Windows): reads YOUR OWN screen while you play.
//   node src/scanner.js
//
// Pipeline: find Roblox window (PowerShell) → screenshot (screenshot-desktop)
//           → crop banner strip (sharp) → OCR (tesseract.js) → parse → POST.
// Server jobId comes from the client's launch args via CIM (passive OS read).
import { loadConfig } from "./config.js";
import { parseBanners } from "./banner.js";
import { imageBufferToText } from "./ocr.js";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const ps = promisify(execFile);

const POLL_MS = 2000;
const REPEAT_SUPPRESS_MS = 60_000;
const lastSeen = new Map();

const PS_WINDOW = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr r,out RECT p);public struct RECT{public int L,T,R,B;}}
"@
$p = Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { $r = New-Object W+RECT; [W]::GetWindowRect($p.MainWindowHandle,[ref]$r) | Out-Null; Write-Output "$($r.L),$($r.T),$($r.R),$($r.B)" } else { Write-Output "" }`;

const PS_JOBID = `
(Get-CimInstance Win32_Process -Filter "Name='RobloxPlayerBeta.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1).CommandLine`;

async function robloxWindowBox() {
  try {
    const { stdout } = await ps("powershell.exe", ["-NoProfile", "-Command", PS_WINDOW]);
    const t = stdout.trim();
    if (!t) return null;
    const [l, t0, r, b] = t.split(",").map(Number);
    if (!r || r - l < 200) return null;
    return { left: l, top: t0, width: r - l, height: b - t0 };
  } catch {
    return null;
  }
}

async function currentJobId() {
  try {
    const { stdout } = await ps("powershell.exe", ["-NoProfile", "-Command", PS_JOBID]);
    const m = stdout.match(/--gameInstanceId[= ]([\w-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function grabBannerRegion() {
  const box = await robloxWindowBox();
  if (!box) return null;
  const screenshot = (await import("screenshot-desktop")).default;
  const sharp = (await import("sharp")).default;
  const buf = await screenshot({ format: "png" });
  // banner = top-center strip of the game window (primary monitor origin)
  const pad = Math.round(box.width * 0.1);
  return sharp(buf)
    .extract({
      left: box.left + pad,
      top: box.top + Math.round(box.height * 0.03),
      width: box.width - 2 * pad,
      height: Math.round(box.height * 0.15),
    })
    .png()
    .toBuffer();
}

async function report(cfg, spawn, jobId) {
  const res = await fetch(`${cfg.api_url}/api/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      egg: spawn.egg, rarity: spawn.rarity, biome: spawn.biome,
      server_id: jobId, source: "client",
      spotter: cfg.roblox_username || null,
    }),
  });
  console.log(`[report] ${spawn.rarity} ${spawn.egg} -> HTTP ${res.status}`);
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.api_url) throw new Error("Set api_url (or EGW_API_URL) to your deployed API");
  console.log("[scanner] watching for the Roblox window — play the game, this reads only your own screen");
  for (;;) {
    try {
      const img = await grabBannerRegion();
      if (img) {
        const text = await imageBufferToText(img);
        for (const spawn of parseBanners(text)) {
          const key = `${spawn.rarity} ${spawn.egg}`.toLowerCase();
          const now = Date.now();
          if (now - (lastSeen.get(key) || 0) < REPEAT_SUPPRESS_MS) continue;
          lastSeen.set(key, now);
          await report(cfg, spawn, await currentJobId());
        }
      }
    } catch (e) {
      console.error("[scanner]", e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
