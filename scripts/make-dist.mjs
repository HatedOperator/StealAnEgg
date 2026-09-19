// Builds the member-facing scanner zip: dist/StealAnEggScanner-win64.zip
// Kids: download, extract, double-click "Start Scanner.bat", type username once.
//
// Usage:  node scripts/make-dist.mjs [apiUrl]
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_URL = process.argv[2] || "https://natural-dedication-production-aae2.up.railway.app";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const OUT = path.join(ROOT, "dist", "StealAnEggScanner");

fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// scanner only (no discord.js/express — keeps the zip small)
fs.writeFileSync(
  path.join(OUT, "package.json"),
  JSON.stringify(
    {
      name: "steal-an-egg-scanner",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        "screenshot-desktop": "^1.15.0",
        sharp: "^0.33.5",
        "tesseract.js": "^5.1.1",
      },
    },
    null,
    2
  )
);

// pre-configured for the deployed API; username asked on first run
fs.writeFileSync(
  path.join(OUT, "scanner-config.json"),
  JSON.stringify({ api_url: API_URL, roblox_username: "" }, null, 2)
);

fs.cpSync(path.join(ROOT, "src"), path.join(OUT, "src"), { recursive: true });

fs.writeFileSync(
  path.join(OUT, "Start Scanner.bat"),
  [
    "@echo off",
    "title Steal an Egg Scanner",
    "cd /d \"%~dp0\"",
    "node.exe src\\scanner.js",
    "echo.",
    "echo Scanner stopped. If that was unexpected, screenshot this window and report it.",
    "pause",
    "",
  ].join("\r\n")
);

fs.writeFileSync(
  path.join(OUT, "READ ME FIRST.txt"),
  [
    "STEAL AN EGG SCANNER — install instructions",
    "",
    "1. Extract this whole folder somewhere you'll keep it (Desktop is fine).",
    "2. Double-click 'Start Scanner.bat'.",
    "3. The first time only: type your Roblox username and press Enter.",
    "4. That's it. Keep the window open (minimize it) while you play.",
    "   Every rare egg you see gets reported automatically and credited to you.",
    "",
    "If Windows shows a blue 'Windows protected your PC' box:",
    "click 'More info' then 'Run anyway'. That warning appears for any",
    "new app that isn't from a big company — this scanner is open source:",
    API_URL.replace(/https:\/\/(.+)\.up\.railway\.app.*/, "") + "github.com/HatedOperator/StealAnEgg",
    "",
    "To stop it: close the window. To uninstall: delete the folder.",
    "",
  ].join("\r\n")
);

console.log("[dist] installing scanner dependencies...");
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: OUT, stdio: "inherit" });

console.log("[dist] bundling node.exe...");
fs.copyFileSync(process.execPath, path.join(OUT, "node.exe"));

console.log("[dist] zipping...");
execSync(
  `powershell.exe -NoProfile -Command "Compress-Archive -Path '${OUT.replace(/'/g, "''")}' -DestinationPath '${path.join(ROOT, "dist", "StealAnEggScanner-win64.zip").replace(/'/g, "''")}' -Force"`,
  { stdio: "inherit" }
);

const mb = (fs.statSync(path.join(ROOT, "dist", "StealAnEggScanner-win64.zip")).size / 1e6).toFixed(1);
console.log(`[dist] done: dist/StealAnEggScanner-win64.zip (${mb} MB) — API: ${API_URL}`);
