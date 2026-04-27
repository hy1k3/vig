#!/usr/bin/env node
/**
 * vig CLI — bootstrap a local video gallery in the current folder.
 *
 *   cd ~/Movies && vig
 *
 * Picks a free port, builds the gallery into .vig/site/, persists user data
 * (shots, heat) in .vig/meta/, and serves on http://localhost:<port>.
 */

import { spawn } from "child_process";
import { createServer as netCreateServer } from "net";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// All paths into .vig/ inside the user's content folder. Absolute, because
// build.js and serve.js are spawned from a Node process whose cwd is the user's
// content folder — relative paths would land in the wrong tree.
const VIG_DIR = resolve(cwd, ".vig");
const VIG_SITE = resolve(VIG_DIR, "site");
const VIG_META = resolve(VIG_DIR, "meta");
const VIG_VIDEOS = cwd;
const VIG_PLAYER_SRC = resolve(__dirname, "vig-player.js");

const env = {
  ...process.env,
  VIG_VIDEOS,
  VIG_SITE,
  VIG_META,
  VIG_PLAYER_SRC,
};

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function runStep(label, args, runEnv) {
  console.log(`vig: ${label}…`);
  return new Promise((res, rej) => {
    const proc = spawn("node", args, { stdio: "inherit", env: runEnv });
    proc.on("error", rej);
    proc.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`${label} exited with code ${code}`));
    });
  });
}

async function main() {
  // Pick a port up-front so we can announce the URL before serve starts.
  const port = parseInt(process.env.VIG_PORT || "", 10) || (await pickFreePort());
  const url = `http://localhost:${port}`;

  // 1. Build into .vig/site
  await runStep("building", [join(__dirname, "build.js")], env);

  // 2. Serve — replaces this process so signals (Ctrl+C) propagate cleanly.
  console.log(`vig: serving ${cwd}`);
  console.log(`     ${url}`);
  const serveProc = spawn(
    "node",
    [join(__dirname, "serve.js")],
    { stdio: "inherit", env: { ...env, VIG_PORT: String(port) } },
  );

  // Forward common signals to the child so Ctrl+C in the CLI stops the server.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { serveProc.kill(sig); } catch {} });
  }

  serveProc.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error("vig:", err.message);
  process.exit(1);
});
