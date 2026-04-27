#!/usr/bin/env node
/**
 * vig dev server
 *
 * Serves _site/ as static files (with HTTP Range support for video scrubbing),
 * plus a tiny shots API that reads/writes <video>.shots.json sidecars next to
 * each video in videos/.
 */

import { createServer } from "http";
import { createReadStream, existsSync, watch } from "fs";
import { readFile, writeFile, stat, mkdir } from "fs/promises";
import { join, extname, resolve, normalize, dirname, sep } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.VIG_PORT || "3001", 10);
const STATIC_ROOT = resolve(process.env.VIG_SITE || "_site");
const VIDEOS_ROOT = resolve(process.env.VIG_VIDEOS || process.cwd());
// site/ = generated build output (safe to wipe). meta/ = persistent user data
// (shots.json, heat.json). Default: meta lives next to site.
const POST_ROOT = join(STATIC_ROOT, "post");
const META_ROOT = resolve(process.env.VIG_META || join(STATIC_ROOT, "meta"));
// Slugs are produced by build.js (lowercase a-z, 0-9, dashes). Validate strictly
// so the API can't be tricked into reading/writing outside the meta tree.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function sanitizeRelPath(rel) {
  if (!rel) return null;
  const clean = normalize(rel).replace(/\\/g, "/");
  // reject traversal, absolute paths, null bytes
  if (clean.includes("\0") || clean.startsWith("/") || clean.startsWith("..") || clean.split("/").includes("..")) {
    return null;
  }
  return clean;
}

function metaDirFor(slug) {
  return join(META_ROOT, slug);
}
function shotsFor(slug) {
  return join(metaDirFor(slug), "shots.json");
}
function heatFor(slug) {
  return join(metaDirFor(slug), "heat.json");
}

// ─── Static ──────────────────────────────────────────────────────────────────

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const rel = sanitizeRelPath(urlPath.replace(/^\/+/, ""));
  if (rel === null) return send(res, 400, "bad path");
  const filePath = join(STATIC_ROOT, rel);

  try {
    const st = await stat(filePath);
    if (st.isDirectory()) {
      const idx = join(filePath, "index.html");
      if (existsSync(idx)) return serveFile(idx, req, res);
      return send(res, 404, "not found");
    }
    return serveFile(filePath, req, res);
  } catch {
    return send(res, 404, "not found");
  }
}

async function serveFile(filePath, req, res) {
  const st = await stat(filePath);
  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size || end >= st.size) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
      });
      return createReadStream(filePath, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": st.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  createReadStream(filePath).pipe(res);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}

// ─── Background rebuild (debounced) ──────────────────────────────────────────
// Triggered after a successful shots POST so preview clips refresh automatically.
// Guarantees at most one build running; if a POST arrives mid-build we queue
// exactly one follow-up. Idempotency inside build.js keeps repeat builds cheap.

let rebuilding = false;
let rebuildQueued = false;

function triggerRebuild() {
  if (rebuilding) { rebuildQueued = true; return; }
  rebuilding = true;
  runOnce();
}

function runOnce() {
  rebuildQueued = false;
  console.log("[rebuild] starting…");
  const t0 = Date.now();
  // Absolute path so this works when serve.js is invoked from a content folder
  // that doesn't contain build.js (i.e. the CLI flow with cloned source in .vig/src).
  const buildPath = join(__dirname, "build.js");
  const proc = spawn("node", [buildPath], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => process.stdout.write("[build] " + d));
  proc.stderr.on("data", (d) => process.stderr.write("[build] " + d));
  proc.on("exit", (code) => {
    const ms = Date.now() - t0;
    console.log(`[rebuild] done in ${ms}ms (exit ${code})`);
    if (rebuildQueued) runOnce();
    else rebuilding = false;
  });
  proc.on("error", (err) => {
    console.error("[rebuild] failed to spawn build:", err.message);
    rebuilding = false;
    rebuildQueued = false;
  });
}

// ─── Shots API ───────────────────────────────────────────────────────────────

async function handleShotsApi(req, res, url) {
  const slug = url.searchParams.get("slug");
  if (!slug || !SLUG_RE.test(slug)) return sendJson(res, 400, { error: "missing or bad slug" });
  if (!existsSync(metaDirFor(slug))) return sendJson(res, 404, { error: "post not found", slug });

  const sidecar = shotsFor(slug);

  if (req.method === "GET") {
    if (!existsSync(sidecar)) return sendJson(res, 200, []);
    try {
      const content = await readFile(sidecar, "utf-8");
      const parsed = JSON.parse(content);
      return sendJson(res, 200, parsed);
    } catch (err) {
      return sendJson(res, 500, { error: "could not read sidecar", detail: err.message });
    }
  }

  if (req.method === "POST" || req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let shots;
    try {
      shots = JSON.parse(body);
      if (!Array.isArray(shots)) throw new Error("must be an array");
      for (const s of shots) {
        if (typeof s.start !== "number" || typeof s.end !== "number") throw new Error("shot needs numeric start/end");
        if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) throw new Error("non-finite time");
        if (s.end < s.start) throw new Error("end before start");
      }
    } catch (err) {
      return sendJson(res, 400, { error: "invalid shots payload", detail: err.message });
    }

    // Sort by start, round to 2 decimals
    const normalised = shots
      .map((s) => ({
        start: Math.max(0, +s.start.toFixed(2)),
        end: +s.end.toFixed(2),
        ...(s.label ? { label: String(s.label).slice(0, 200) } : {}),
      }))
      .sort((a, b) => a.start - b.start);

    try {
      await mkdir(dirname(sidecar), { recursive: true });
      await writeFile(sidecar, JSON.stringify(normalised, null, 2));
      // Don't block the response on the rebuild — it runs in the background and
      // the user's browser just needs to refresh the feed to see new clips.
      triggerRebuild();
      return sendJson(res, 200, { ok: true, count: normalised.length, shots: normalised, rebuilding: true });
    } catch (err) {
      return sendJson(res, 500, { error: "could not write sidecar", detail: err.message });
    }
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

// ─── Heat API ────────────────────────────────────────────────────────────────
// Tracks watch heatmaps per video. Client POSTs continuous-viewing intervals
// (≥ a few seconds) as { from, to }; server buckets them into 1-second slots,
// accumulating over every visit.

const HEAT_BUCKET_SIZE = 1; // seconds per bucket — 1s gives ample resolution

async function handleHeatApi(req, res, url) {
  const slug = url.searchParams.get("slug");
  if (!slug || !SLUG_RE.test(slug)) return sendJson(res, 400, { error: "missing or bad slug" });
  if (!existsSync(metaDirFor(slug))) return sendJson(res, 404, { error: "post not found", slug });

  const heatPath = heatFor(slug);

  if (req.method === "GET") {
    if (!existsSync(heatPath)) return sendJson(res, 200, { bucketSize: HEAT_BUCKET_SIZE, buckets: [] });
    try {
      return sendJson(res, 200, JSON.parse(await readFile(heatPath, "utf-8")));
    } catch (err) {
      return sendJson(res, 500, { error: "could not read heat", detail: err.message });
    }
  }

  if (req.method === "POST" || req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let data;
    try {
      data = JSON.parse(body);
      if (typeof data?.from !== "number" || typeof data?.to !== "number") throw new Error("from/to must be numbers");
      if (!Number.isFinite(data.from) || !Number.isFinite(data.to)) throw new Error("non-finite time");
      if (data.to <= data.from) throw new Error("to must be greater than from");
    } catch (err) {
      return sendJson(res, 400, { error: "invalid heat payload", detail: err.message });
    }

    let heat = { bucketSize: HEAT_BUCKET_SIZE, buckets: [] };
    if (existsSync(heatPath)) {
      try {
        const parsed = JSON.parse(await readFile(heatPath, "utf-8"));
        if (parsed && Array.isArray(parsed.buckets) && typeof parsed.bucketSize === "number") {
          heat = parsed;
        }
      } catch { /* fall through to fresh */ }
    }

    const bs = heat.bucketSize || HEAT_BUCKET_SIZE;
    const startBucket = Math.floor(Math.max(0, data.from) / bs);
    const endBucket = Math.ceil(data.to / bs);
    // Fill any gaps with 0 first, so JSON.stringify doesn't produce `null` holes.
    for (let i = heat.buckets.length; i < endBucket; i++) heat.buckets[i] = 0;
    for (let i = startBucket; i < endBucket; i++) {
      heat.buckets[i] = (heat.buckets[i] || 0) + 1;
    }

    try {
      await mkdir(dirname(heatPath), { recursive: true });
      await writeFile(heatPath, JSON.stringify(heat));
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: "could not write heat", detail: err.message });
    }
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/_api/shots") {
      return await handleShotsApi(req, res, url);
    }
    if (url.pathname === "/_api/heat") {
      return await handleHeatApi(req, res, url);
    }
    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return send(res, 500, "internal error");
  }
});

server.listen(PORT, () => {
  console.log(`vig: http://localhost:${PORT}`);
  console.log(`  static: ${STATIC_ROOT}`);
  console.log(`  videos: ${VIDEOS_ROOT}`);
  console.log(`  api:    /_api/shots?slug=<post-slug>  [GET | POST | PUT]`);
  console.log(`          /_api/heat?slug=<post-slug>   [GET | POST]`);
  setupWatch();
  // Run a build immediately so a fresh `npm run serve` produces output without
  // needing a separate `npm run build` first. Idempotency keeps it cheap when
  // nothing's changed.
  triggerRebuild();
});

// ─── File-watch driven rebuilds ──────────────────────────────────────────────
// Watches the source folder for video changes and build.js for code changes.
// Filters out OS noise (Spotlight, Finder visits, .DS_Store updates) by only
// reacting to actual video file events. Debounced so multiple events coalesce.

const VIDEO_FILE_RE = /\.(mp4|mov|webm|m4v)$/i;

function isInterestingVideoEvent(filename) {
  if (!filename) return false;
  // Reject paths containing any dot-prefixed segment (.DS_Store, ._meta, etc.).
  const segments = filename.split(/[/\\]/);
  if (segments.some((s) => s.startsWith("."))) return false;
  return VIDEO_FILE_RE.test(filename);
}

let watchDebounce = null;
function scheduleRebuild(reason) {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    console.log(`[watch] ${reason} — rebuilding`);
    triggerRebuild();
  }, 1000);
}

function setupWatch() {
  try {
    if (existsSync(VIDEOS_ROOT)) {
      watch(VIDEOS_ROOT, { recursive: true }, (event, filename) => {
        if (!isInterestingVideoEvent(filename)) return;
        scheduleRebuild(filename);
      });
    }
    const buildPath = join(__dirname, "build.js");
    if (existsSync(buildPath)) {
      watch(buildPath, () => scheduleRebuild("build.js"));
    }
    const playerPath = process.env.VIG_PLAYER_SRC || join(__dirname, "vig-player.js");
    if (existsSync(playerPath)) {
      watch(playerPath, () => scheduleRebuild("vig-player.js"));
    }
    console.log(`  watch:  ${VIDEOS_ROOT}, build.js, vig-player.js  (auto-rebuild on changes)`);
  } catch (err) {
    console.warn(`[watch] could not set up watchers: ${err.message}`);
  }
}
