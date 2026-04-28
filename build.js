#!/usr/bin/env node
/**
 * vig — Static site generator for a personal video gallery
 *
 * Recursively scans videos/ for .mp4/.mov/.webm/.m4v files and generates
 * a static site with a Datastar-powered feed + grid browser.
 */

import { readdir, readFile, writeFile, mkdir, copyFile, symlink, link, lstat, rm, stat } from "fs/promises";
import { join, extname, basename, dirname, relative, resolve, sep, posix } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
// All paths are env-driven so the CLI (cli.js) can point them at .vig/site
// and .vig/meta inside the user's content folder. Defaults assume direct
// invocation from the vig project root.
const CONTENT_DIR = process.env.VIG_VIDEOS || process.cwd();
const OUT_DIR = process.env.VIG_SITE || "_site";
const META_ROOT = process.env.VIG_META || join(OUT_DIR, "meta");
const PLAYER_SRC = process.env.VIG_PLAYER_SRC || join(__dirname, "vig-player.js");
const POST_DIR = "post"; // subfolder of OUT_DIR
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IGNORE_NAMES = new Set([".DS_Store", "node_modules", "_site", ".vig"]);

function postOutDir(slug) {
  return join(OUT_DIR, POST_DIR, slug);
}
function metaOutDir(slug) {
  return join(META_ROOT, slug);
}
function videoFileName(originalFilename) {
  return "video" + extname(originalFilename);  // preserves source extension for MIME type
}

// ─── Walker ──────────────────────────────────────────────────────────────────

async function walkVideos(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    // readdir with withFileTypes returns Dirents whose .isDirectory()/.isFile()
    // refer to the link itself for symlinks — so a symlink to a folder reports
    // isDirectory()=false. Follow symlinks via stat() so users can drop a link
    // to e.g. an external drive into the content folder and have it scanned.
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const t = await stat(full);
        isDir = t.isDirectory();
        isFile = t.isFile();
      } catch {
        continue; // dangling symlink — skip silently
      }
    }

    if (isDir) {
      const nested = await walkVideos(full, base);
      out.push(...nested);
    } else if (isFile && VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
      const rel = relative(base, full).split(sep).join("/"); // posix for URLs
      const parentRel = dirname(rel) === "." ? "" : dirname(rel);
      const s = await stat(full);

      out.push({
        filename: entry.name,
        relPath: rel,            // "folder/sub/video.mp4"
        folder: parentRel,       // "folder/sub" (may be "")
        size: s.size,
        mtime: s.mtime.toISOString(),
      });
    }
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Single-line live progress, only when stdout is a TTY (so piped/spawned
// builds don't get \r escapes mixed into their logs).
function progress(line) {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K" + line);
}
function progressClear() {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}
function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function slugify(str) {
  let s = String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  // Slug must be non-empty AND start with [a-z0-9] (matches the API's SLUG_RE).
  // Sources with all-special-character names (e.g. "###.mp4") would otherwise
  // produce an empty slug and land at _site/post/video.mp4 instead of in a folder.
  if (!s) s = "untitled";
  if (!/^[a-z0-9]/.test(s)) s = "v-" + s;
  return s;
}

function titleFromFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatBytes(n) {
  if (n >= 1_073_741_824) return (n / 1_073_741_824).toFixed(1).replace(/\.0$/, "") + " GB";
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(1).replace(/\.0$/, "") + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function timeAgo(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 604800) return Math.floor(diff / 86400) + "d";
  if (diff < 31536000) return Math.floor(diff / 604800) + "w";
  return Math.floor(diff / 31536000) + "y";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function folderLabel(folder) {
  return folder ? folder : "root";
}

function folderInitial(folder) {
  const label = folderLabel(folder);
  return label[0]?.toUpperCase() || "?";
}

// URL-encode a relative path's individual segments (preserves "/"), so filenames
// with spaces, "#", "?", "&", etc. resolve correctly when the browser fetches them.
function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// Cumulative offsets of each clip within the stitched preview.mp4 (in seconds).
// Used by the JS so it can map preview.mp4 currentTime back to the right
// source-video timestamp when updating the deep-link href.
function previewCums(plan) {
  if (!plan || !Array.isArray(plan.ranges)) return [];
  const out = [];
  let cum = 0;
  for (const r of plan.ranges) {
    out.push(cum);
    cum += r.duration;
  }
  return out;
}

// Deterministic hash from a slug — same input always yields the same number,
// so layout decisions (e.g. which horizontal gets a big 2x2 tile) don't shift
// between rebuilds. djb2-style; modulo a small N gives stable bucketing.
function slugHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return Math.abs(h);
}


// ─── ffmpeg: poster frame extraction ─────────────────────────────────────────

function spawnCapture(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    // stdin: ignore — ffmpeg occasionally misbehaves when its stdin is an open
    // pipe nobody writes to (especially when this process itself was spawned
    // without a controlling terminal, as the dev server does).
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", () => resolve({ code: -1, out, err: "command not found" }));
    proc.on("close", (code) => resolve({ code, out, err }));
  });
}

async function checkFfmpeg() {
  const r = await spawnCapture("ffmpeg", ["-version"]);
  if (r.code === 0) {
    // First-line of `ffmpeg -version` is e.g. "ffmpeg version 6.1 …".
    // Logging it surfaces the case where `npm run dev` finds a different
    // ffmpeg via $PATH than your interactive shell does.
    const which = await spawnCapture("which", ["ffmpeg"]);
    const verLine = (r.out || "").split("\n")[0];
    console.log(`  ffmpeg:   ${which.out.trim() || "?"}  (${verLine})`);
  }
  return r.code === 0;
}

// One ffprobe call returns everything we need: duration, dimensions, framerate,
// and bitrate. The bits-per-pixel-per-second derived from those drives the
// adaptive encoder picks below.
async function getMetadata(srcPath) {
  const r = await spawnCapture("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,bit_rate:format=duration,bit_rate",
    "-of", "json",
    srcPath,
  ]);
  if (r.code !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(r.out); } catch { return null; }
  const stream = parsed?.streams?.[0];
  const format = parsed?.format;
  if (!stream || !format) return null;

  const duration = parseFloat(format.duration);
  const width = parseInt(stream.width, 10);
  const height = parseInt(stream.height, 10);
  const fps = parseFraction(stream.r_frame_rate) || 30;
  const bitrate = parseInt(stream.bit_rate || format.bit_rate || "0", 10);
  const bpp = (width && height && fps && bitrate) ? bitrate / (width * height * fps) : 0;

  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: width || null,
    height: height || null,
    fps,
    bitrate,
    bpp,
  };
}

function parseFraction(s) {
  if (!s) return 0;
  const parts = String(s).split("/");
  if (parts.length === 2) {
    const n = parseFloat(parts[0]);
    const d = parseFloat(parts[1]);
    if (d > 0 && Number.isFinite(n) && Number.isFinite(d)) return n / d;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

// Adaptive encoder settings — match the encode quality to the source so we don't
// add more compression artifacts on top of an already-grainy input. Thresholds
// are bits per pixel per second:
//   ≥0.10  : modern good-source (Netflix-tier) → slight compression OK
//   ≥0.04  : decent source                     → moderate quality
//   ≥0.02  : low-bitrate source                → preserve detail, tune for grain
//   <0.02  : very low bitrate                  → nearly transparent, tune for grain
const ENCODER_TIERS = {
  high:       { crf: 24, preset: "medium", tune: null },
  medium:     { crf: 22, preset: "medium", tune: null },
  low:        { crf: 20, preset: "slow",   tune: "grain" },
  "very-low": { crf: 18, preset: "slow",   tune: "grain" },
  unknown:    { crf: 23, preset: "medium", tune: null },
};

function qualityTier(meta) {
  if (!meta || !meta.bpp) return "unknown";
  if (meta.bpp >= 0.10) return "high";
  if (meta.bpp >= 0.04) return "medium";
  if (meta.bpp >= 0.02) return "low";
  return "very-low";
}

// Preview layout: every video gets poster.jpg + N short MP4 clips (01.mp4..NN.mp4).
// Auto mode (no sidecar) samples evenly; user-shots mode uses the user's ranges.
const AUTO_PERCENTS = [0.20, 0.40, 0.60, 0.80];
const AUTO_CLIP_SECONDS = 1.8;           // length of each auto-mode clip
const SHORT_VIDEO_THRESHOLD = 10;        // shorter than this → single full-video clip
const MAX_USER_CLIPS = 8;                // cap cycling clips per card
const MAX_CLIP_SECONDS = 8;              // cap user-shot clip length

// Target the SHORT side of the frame (not the width) — ensures portrait and
// landscape videos both get enough pixels to fill the feed card crisply. Grid
// cells downscale cleanly from this; feed cards at ~470px get a sharp preview
// even on retina displays.
const PREVIEW_SHORT_SIDE = 720;
const PREVIEW_SCALE = `scale=w='if(gt(iw,ih),-2,${PREVIEW_SHORT_SIDE})':h='if(gt(iw,ih),${PREVIEW_SHORT_SIDE},-2)'`;

// VIG_DEBUG=1 streams every ffmpeg/ffprobe invocation (args + stderr) to the
// console — useful when previews come out wrong and you need to see exactly
// what's being run.
const DEBUG = !!process.env.VIG_DEBUG;

async function extractFrameAt(srcPath, destPath, seekSeconds) {
  await mkdir(dirname(destPath), { recursive: true });
  const args = [
    "-y", "-loglevel", "error",
    "-nostdin",                  // critical: without this ffmpeg can misbehave when stdin is a pipe (non-TTY)
    "-ss", String(seekSeconds),  // fast seek (before -i)
    "-i", srcPath,
    "-vframes", "1",
    "-vf", PREVIEW_SCALE,
    "-q:v", "4",
    destPath,
  ];
  if (DEBUG) console.log(`[debug] extractFrameAt: ffmpeg ${args.join(" ")}`);
  const r = await spawnCapture("ffmpeg", args);
  if (DEBUG && r.err) console.log(`[debug] stderr:\n${r.err.split("\n").map((l) => "    " + l).join("\n")}`);
  return r.code === 0;
}

async function extractClip(srcPath, destPath, startSec, durationSec, settings) {
  await mkdir(dirname(destPath), { recursive: true });
  // Single -ss before -i. With re-encode (-c:v libx264) modern ffmpeg does
  // keyframe seek + accurate trim by default; +genpts regenerates timestamps
  // for sources whose PTS was broken (which is what was making subsequent clips
  // come out as 1-frame: ffmpeg's accurate-seek logic relies on sane PTS).
  const args = [
    "-y", "-loglevel", "error",
    "-nostdin",                  // critical: without this ffmpeg can misbehave when stdin is a pipe (non-TTY)
    "-fflags", "+genpts",
    "-ss", String(startSec),
    "-i", srcPath,
    "-t", String(durationSec),
    "-vf", PREVIEW_SCALE,
    "-c:v", "libx264",
    "-preset", settings.preset,
    "-crf", String(settings.crf),
  ];
  if (settings.tune) args.push("-tune", settings.tune);
  args.push(
    "-an",                      // strip audio — smaller files, no mute-on-autoplay hassle
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    destPath,
  );
  if (DEBUG) console.log(`[debug] extractClip: ffmpeg ${args.join(" ")}`);
  const r = await spawnCapture("ffmpeg", args);
  if (DEBUG && r.err) console.log(`[debug] stderr:\n${r.err.split("\n").map((l) => "    " + l).join("\n")}`);
  if (r.code !== 0) {
    const stderr = (r.err || "").trim();
    console.warn(`  ffmpeg clip failed (start=${startSec.toFixed(2)}, dur=${durationSec.toFixed(2)})`);
    console.warn(`    src: ${srcPath}`);
    if (stderr) console.warn(`    err: ${stderr.split("\n").slice(-3).join(" | ")}`);
    return false;
  }
  // Sanity check: count actual packets — the container's reported duration can
  // lie when a clip has only one frame (header says full length, stream is empty).
  try {
    const probe = await spawnCapture("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_packets",
      "-show_entries", "stream=nb_read_packets",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      destPath,
    ]);
    const lines = probe.out.trim().split("\n");
    const nb = parseInt(lines[0], 10);
    const out = parseFloat(lines[1]);
    if (Number.isFinite(nb) && nb < 5 && durationSec > 0.5) {
      console.warn(`  BAD clip: ${destPath} only ${nb} packet${nb === 1 ? "" : "s"} (asked ${durationSec.toFixed(2)}s, start ${startSec.toFixed(2)})`);
      console.warn(`    src: ${srcPath}`);
      console.warn(`    ffmpeg args: ${args.join(" ")}`);
      console.warn(`    ffmpeg stderr:\n${(r.err || "(empty)").split("\n").map((l) => "      " + l).join("\n")}`);
    } else if (Number.isFinite(out) && out < durationSec * 0.5 && durationSec > 0.5) {
      console.warn(`  short clip: ${destPath} got ${out.toFixed(2)}s (asked ${durationSec.toFixed(2)}s, start ${startSec.toFixed(2)})`);
      console.warn(`    ffmpeg stderr:\n${(r.err || "(empty)").split("\n").map((l) => "      " + l).join("\n")}`);
    }
  } catch (probeErr) {
    console.warn(`  ffprobe check failed for ${destPath}: ${probeErr.message}`);
  }
  return true;
}

// Stitch the per-shot clips into a single preview.mp4 so the feed/grid card can
// loop through them with no black flash between source swaps. Uses ffmpeg's
// concat demuxer with -c copy, which is instant: it stitches the existing H.264
// streams without re-encoding (all clips share the same codec/scale settings).
async function concatClips(destDir, count) {
  if (count < 2) {
    // Single clip — just copy/link it as preview.mp4 (cheap, but skip if it'd be a no-op).
    const single = join(destDir, "01.mp4");
    const out = join(destDir, "preview.mp4");
    if (existsSync(single)) {
      await rm(out, { force: true });
      try { await link(single, out); } catch { await copyFile(single, out); }
      return true;
    }
    return false;
  }
  const listPath = join(destDir, ".concat-list.txt");
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`file '${String(i).padStart(2, "0")}.mp4'`);
  }
  await writeFile(listPath, lines.join("\n"));
  const concatArgs = [
    "-y", "-loglevel", "error",
    "-nostdin",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    join(destDir, "preview.mp4"),
  ];
  if (DEBUG) console.log(`[debug] concatClips: ffmpeg ${concatArgs.join(" ")}`);
  const r = await spawnCapture("ffmpeg", concatArgs);
  if (DEBUG && r.err) console.log(`[debug] stderr:\n${r.err.split("\n").map((l) => "    " + l).join("\n")}`);
  await rm(listPath, { force: true });
  return r.code === 0;
}

// Peak-finding from a heat sidecar: pick the N hottest non-overlapping points
// in the buckets array and return clip windows centred on each. Returns null
// when the heat is empty or doesn't have any signal worth deriving from.
function deriveClipsFromHeat(heat, { count = AUTO_PERCENTS.length, clipDuration = AUTO_CLIP_SECONDS, minPeak = 1 } = {}) {
  if (!heat || !Array.isArray(heat.buckets) || heat.buckets.length === 0) return null;
  const bs = heat.bucketSize || 1;
  const work = heat.buckets.slice();
  let max = 0;
  for (const v of work) if (v > max) max = v;
  if (max < minPeak) return null;

  // Exclusion zone around each pick — keeps derived clips spread out instead
  // of clustering on the front of a flat-but-watched stretch.
  const exclusion = Math.max(1, Math.round((clipDuration * 5) / bs));
  const halfDur = clipDuration / 2;
  const clips = [];

  for (let n = 0; n < count; n++) {
    let maxIdx = -1, maxVal = 0;
    for (let i = 0; i < work.length; i++) {
      if (work[i] > maxVal) { maxVal = work[i]; maxIdx = i; }
    }
    if (maxIdx < 0 || maxVal < minPeak) break;

    const center = (maxIdx + 0.5) * bs;
    clips.push({ start: Math.max(0, center - halfDur), end: center + halfDur });

    const lo = Math.max(0, maxIdx - exclusion);
    const hi = Math.min(work.length, maxIdx + exclusion);
    for (let i = lo; i < hi; i++) work[i] = 0;
  }

  if (clips.length === 0) return null;
  clips.sort((a, b) => a.start - b.start);
  return clips;
}

// Work out what clips to make for this post — source of truth for both generation
// and idempotent cleanup. Returns { ranges: [{start, duration}], posterAt: seconds }.
function previewPlan(post, duration) {
  if (post.shots && post.shots.length > 0) {
    const shots = post.shots.slice(0, MAX_USER_CLIPS);
    return {
      ranges: shots.map((s) => ({
        start: s.start,
        duration: Math.min(s.end - s.start, MAX_CLIP_SECONDS),
      })),
      posterAt: (shots[0].start + shots[0].end) / 2,
    };
  }

  // No manual shots — try the heat sidecar before falling back to fixed percentages.
  const derived = deriveClipsFromHeat(post.heat);
  if (derived) {
    return {
      ranges: derived.map((c) => ({ start: c.start, duration: c.end - c.start })),
      posterAt: (derived[0].start + derived[0].end) / 2,
    };
  }

  if (duration && duration < SHORT_VIDEO_THRESHOLD) {
    // Tiny clip: one full-video snippet that loops natively in the card.
    return {
      ranges: [{ start: 0, duration }],
      posterAt: duration * 0.4,
    };
  }
  if (duration) {
    return {
      ranges: AUTO_PERCENTS.map((p) => ({
        start: Math.max(0.1, duration * p),
        duration: AUTO_CLIP_SECONDS,
      })),
      posterAt: duration * 0.4,
    };
  }
  // Probe failed — guess.
  return {
    ranges: [0.5, 2.5, 4.5, 6.5].map((t) => ({ start: t, duration: AUTO_CLIP_SECONDS })),
    posterAt: 2.5,
  };
}

function expectedPreviewFiles(plan) {
  const files = ["poster.jpg", "preview.mp4"];
  for (let i = 0; i < plan.ranges.length; i++) {
    files.push(`${String(i + 1).padStart(2, "0")}.mp4`);
  }
  return files;
}

async function extractPreviews(post, srcPath, destDir, meta) {
  const tier = qualityTier(meta);
  const settings = ENCODER_TIERS[tier];
  const plan = previewPlan(post, meta?.duration);

  const posterOk = await extractFrameAt(srcPath, join(destDir, "poster.jpg"), plan.posterAt);
  // Serial extraction (was Promise.all) — concurrent ffmpegs on the same source
  // produced 1-frame clips for non-faststart inputs where each process has to
  // re-read the moov atom from file-end. The first clip would succeed and the
  // rest would land badly. Serial costs ~1-2s extra per video; reliability wins.
  const clipResults = [];
  for (let i = 0; i < plan.ranges.length; i++) {
    const r = plan.ranges[i];
    const dest = join(destDir, `${String(i + 1).padStart(2, "0")}.mp4`);
    clipResults.push(await extractClip(srcPath, dest, r.start, r.duration, settings));
  }

  // Stitch the clips into a single seamless preview.mp4 (no re-encode, just
  // concat). This is what the feed/grid card actually plays — looping a single
  // file means no black flash between cycles.
  let concatOk = false;
  if (clipResults.every(Boolean)) {
    concatOk = await concatClips(destDir, plan.ranges.length);
  }

  post.previewCount = plan.ranges.length;
  post.previewPlan = plan;
  post.qualityTier = tier;
  return posterOk && concatOk;
}

// ─── Build dependency tracking ───────────────────────────────────────────────
// A per-video manifest (.build-meta.json) records what produced the existing
// previews: the source/sidecar mtimes AND a hash of the encoding pipeline.
// If any of those change — including pure code edits to the extract functions
// or their constants — the affected videos re-encode on next build.

const BUILD_META_NAME = ".build-meta.json";

function getPipelineHash() {
  // Hash only the encoder-relevant code: layout/CSS edits stay cheap, but a
  // tweak to scale/CRF/clip-length or the heat-derivation algorithm forces a
  // rebuild of every video.
  const sources = [
    extractFrameAt.toString(),
    extractClip.toString(),
    concatClips.toString(),
    extractPreviews.toString(),
    previewPlan.toString(),
    expectedPreviewFiles.toString(),
    deriveClipsFromHeat.toString(),
    qualityTier.toString(),
    `ENCODER_TIERS=${JSON.stringify(ENCODER_TIERS)}`,
    `PREVIEW_SCALE=${PREVIEW_SCALE}`,
    `PREVIEW_SHORT_SIDE=${PREVIEW_SHORT_SIDE}`,
    `MAX_CLIP_SECONDS=${MAX_CLIP_SECONDS}`,
    `AUTO_CLIP_SECONDS=${AUTO_CLIP_SECONDS}`,
    `SHORT_VIDEO_THRESHOLD=${SHORT_VIDEO_THRESHOLD}`,
    `MAX_USER_CLIPS=${MAX_USER_CLIPS}`,
    `AUTO_PERCENTS=${AUTO_PERCENTS.join(",")}`,
  ];
  return createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 16);
}

async function readBuildMeta(dir) {
  const path = join(dir, BUILD_META_NAME);
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, "utf-8")); } catch { return null; }
}

async function writeBuildMeta(dir, meta) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, BUILD_META_NAME), JSON.stringify(meta, null, 2));
}

async function generateThumbs(posts) {
  const ok = await checkFfmpeg();
  if (!ok) {
    console.log("  ffmpeg not found on PATH — skipping previews");
    console.log("  (grid view will show folder-initial placeholders; install via `brew install ffmpeg`)");
    return false;
  }

  const pipelineHash = getPipelineHash();

  let generated = 0, skipped = 0, failed = 0, fromShots = 0;
  const tierCounts = {};

  // Phase 1: gather state for all posts in parallel. Pure I/O — read each
  // post's .build-meta.json, decide if it's cached. ffprobe and hash are only
  // called when needed (cache miss / mtime mismatch).
  const states = await Promise.all(posts.map(async (post) => {
    const srcPath = join(CONTENT_DIR, post.relPath);
    const destDir = post.outDir;
    const srcMs = new Date(post.mtime).getTime();
    const sidecarMs = post.sidecarMtime || 0;
    const heatMs = post.heatMtime || 0;

    const buildMeta = await readBuildMeta(destDir);
    const mtimeMatches = !!(buildMeta && buildMeta.srcMtime === srcMs);

    // mtime-touch fallback: if mtime moved but file size is identical to the
    // cached size, the content is virtually certainly unchanged (Spotlight,
    // Time Machine, Drive Sync, etc. touch mtimes without writing bytes).
    // For videos especially, two distinct files happening to have the exact
    // same byte count is so unlikely it's not worth hashing for.
    let mtimeRefresh = false;
    let contentUnchanged = mtimeMatches;
    if (!mtimeMatches && buildMeta && buildMeta.srcSize === post.size) {
      contentUnchanged = true;
      mtimeRefresh = true;  // refresh mtime in manifest so next run takes the fast path
    }

    // Use cached metadata when source content is unchanged.
    let meta = null;
    if (contentUnchanged && buildMeta?.metadata) {
      meta = buildMeta.metadata;
    }

    let plan = null, expectedFiles = null, fresh = false;
    if (meta) {
      post.dimensions = meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
      post.qualityTier = qualityTier(meta);

      plan = previewPlan(post, meta.duration);
      expectedFiles = expectedPreviewFiles(plan);

      const metaMatches = buildMeta
        && buildMeta.pipelineHash === pipelineHash
        && buildMeta.sidecarMtime === sidecarMs
        && buildMeta.heatMtime === heatMs
        && buildMeta.frameCount === plan.ranges.length;

      fresh = metaMatches;
      if (fresh) {
        for (const name of expectedFiles) {
          if (!existsSync(join(destDir, name))) { fresh = false; break; }
        }
      }
    }

    return { post, srcPath, destDir, srcMs, sidecarMs, heatMs, meta, plan, expectedFiles, fresh, buildMeta, mtimeRefresh };
  }));

  // Phase 2: handle the cached posts in parallel (just file housekeeping —
  // restore previewPlan onto the post so templates have it, and tidy any
  // stale stragglers in their dirs). If we verified content via hash because
  // mtime moved, also write back a refreshed manifest so the next build can
  // use the fast mtime path again.
  await Promise.all(states.filter((s) => s.fresh).map(async (s) => {
    s.post.hasThumb = true;
    s.post.previewCount = s.plan.ranges.length;
    s.post.previewPlan = s.plan;
    if (s.post.shots.length > 0) fromShots++;
    skipped++;
    tierCounts[s.post.qualityTier] = (tierCounts[s.post.qualityTier] || 0) + 1;
    await cleanupStaleFiles(s.destDir, s.expectedFiles);
    if (s.mtimeRefresh) {
      await writeBuildMeta(s.destDir, {
        ...s.buildMeta,
        srcMtime: s.srcMs,
      });
    }
  }));

  // Phase 3: stale posts — sequential because ffmpeg has trouble with
  // multiple concurrent encodes against the same source filesystem.
  const stale = states.filter((s) => !s.fresh);
  const phaseStart = Date.now();
  for (let i = 0; i < stale.length; i++) {
    const s = stale[i];
    const pct = stale.length > 0 ? Math.floor((i / stale.length) * 100) : 0;
    const elapsed = (Date.now() - phaseStart) / 1000;
    const eta = i > 0 ? (elapsed / i) * (stale.length - i) : null;
    const etaStr = eta != null ? `  · ~${formatDuration(eta)} left` : "";
    progress(`  encoding ${i + 1}/${stale.length} (${pct}%)${etaStr}  ${s.post.title}`);
    // No cached metadata? Probe now (this is the first time we see this video).
    if (!s.meta) {
      s.meta = await getMetadata(s.srcPath);
      s.post.dimensions = s.meta && s.meta.width && s.meta.height
        ? { w: s.meta.width, h: s.meta.height } : null;
      s.post.qualityTier = qualityTier(s.meta);
      s.plan = previewPlan(s.post, s.meta?.duration);
      s.expectedFiles = expectedPreviewFiles(s.plan);
    }
    tierCounts[s.post.qualityTier] = (tierCounts[s.post.qualityTier] || 0) + 1;

    await cleanupStaleFiles(s.destDir, s.expectedFiles);
    const success = await extractPreviews(s.post, s.srcPath, s.destDir, s.meta);
    if (success) {
      s.post.hasThumb = true;
      generated++;
      if (s.post.shots.length > 0) fromShots++;
      await writeBuildMeta(s.destDir, {
        pipelineHash,
        srcMtime: s.srcMs,
        srcSize: s.post.size,
        sidecarMtime: s.sidecarMs,
        heatMtime: s.heatMs,
        frameCount: s.plan.ranges.length,
        qualityTier: s.post.qualityTier,
        metadata: s.meta,
      });
    } else {
      failed++;
      console.warn(`  previews failed: ${s.post.relPath}`);
    }
  }
  progressClear();

  const parts = [];
  if (generated) parts.push(`${generated} new`);
  if (skipped) parts.push(`${skipped} cached`);
  if (failed) parts.push(`${failed} failed`);
  if (fromShots) parts.push(`${fromShots} from user shots`);
  console.log(`  previews: ${parts.join(", ") || "none"}`);

  const tierOrder = ["high", "medium", "low", "very-low", "unknown"];
  const tierLine = tierOrder
    .filter((t) => tierCounts[t])
    .map((t) => `${tierCounts[t]} ${t}`)
    .join(", ");
  if (tierLine) console.log(`  quality:  ${tierLine}`);
  return true;
}

async function cleanupStaleFiles(destDir, keepSet) {
  if (!existsSync(destDir)) return;
  const keep = new Set(keepSet);
  try {
    const entries = await readdir(destDir);
    for (const name of entries) {
      if (!keep.has(name) && /^(poster\.jpg|preview\.mp4|\d{2}\.(jpg|mp4))$/.test(name)) {
        await rm(join(destDir, name), { force: true });
      }
    }
  } catch { /* ignore */ }
}


function videoPlayerScript() {
  return `
  <script>
  document.addEventListener('DOMContentLoaded', function() {
    // ── vig-player integration (detail pages only) ──
    // The custom element handles playback/scrubbing/in-out marking and emits
    // shots-change events. We:
    //   1) push the URL ?t=<seconds> into the player as start-at
    //   2) POST shot edits to the sidecar API
    //   3) track watched intervals (heatmap) and POST them to /_api/heat
    if (window.customElements && customElements.whenDefined) {
      customElements.whenDefined('vig-player').then(function() {
        document.querySelectorAll('vig-player').forEach(setupPlayer);
      });
    }

    function setupPlayer(player) {
      var t = parseFloat(new URLSearchParams(location.search).get('t'));
      if (isFinite(t) && t > 0) player.setAttribute('start-at', String(t));

      // Prefer history.back() over the player's back-href so the browser can
      // restore scroll position on the feed. The back-href stays as fallback
      // for direct URL loads where there's no history to pop.
      player.addEventListener('back', function(e) {
        if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
      });

      var slug = player.dataset.slug;
      if (!slug) return;

      player.addEventListener('shots-change', function(e) {
        fetch('/_api/shots?slug=' + encodeURIComponent(slug), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(e.detail.shots),
        }).catch(function(err) { console.warn('shots save failed:', err); });
      });

      // Heat tracking — needs the inner <video> element from the player's open shadow DOM.
      var video = player.shadowRoot && player.shadowRoot.querySelector('.vp-video');
      if (video) bindHeat(video, slug);
    }

    function bindHeat(video, slug) {
      // Threshold for what counts as "watched": short scrubs / accidental plays
      // shouldn't pollute the heatmap. SEEK_JUMP detects forward/backward jumps
      // bigger than a normal timeupdate delta.
      var MIN_DUR = 2;
      var SEEK_JUMP = 2;
      var session = null;

      function endSession(useBeacon) {
        if (!session) return;
        var s = session; session = null;
        var dur = s.lastTime - s.start;
        if (dur < MIN_DUR) return;
        var payload = JSON.stringify({ from: s.start, to: s.lastTime });
        var url = '/_api/heat?slug=' + encodeURIComponent(slug);
        if (useBeacon && navigator.sendBeacon) {
          try { navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' })); } catch (e) {}
        } else {
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true,
          }).catch(function(){});
        }
      }

      video.addEventListener('play', function() {
        session = { start: video.currentTime, lastTime: video.currentTime };
      });
      video.addEventListener('timeupdate', function() {
        if (!session) return;
        var t = video.currentTime;
        if (Math.abs(t - session.lastTime) > SEEK_JUMP) {
          // Seek detected — flush current span, start a new one at the jump target.
          endSession(false);
          session = { start: t, lastTime: t };
        } else {
          session.lastTime = t;
        }
      });
      video.addEventListener('pause', function() { endSession(false); });
      video.addEventListener('ended', function() { endSession(false); });
      // Tab close / navigate-away — beacon is the only reliable method here.
      window.addEventListener('pagehide', function() { endSession(true); });
    }

    // ── Hot-shots previews ──
    // Every card is a <video>. JS plays clip 01.mp4 on hover / entering viewport
    // and cycles src through NN.mp4 when a clip ends. Single-clip cards use the
    // native video.loop attribute for seamless looping.
    var cards = [];

    document.querySelectorAll('.hot-shots').forEach(function(el) {
      var base = el.dataset.hotShots;
      var count = parseInt(el.dataset.hotShotsCount, 10) || 1;
      if (!base || count < 1) return;

      var handlers = setupClipCycle(el, base, count);
      if (!handlers) return;

      el.addEventListener('mouseenter', handlers.start);
      el.addEventListener('mouseleave', handlers.stop);
      cards.push({ el: el, handlers: handlers });
    });

    function setupClipCycle(el, base, count) {
      var video = el.querySelector('.hot-shots-video');
      if (!video) return null;

      // Source-video start seconds per shot, and cumulative offsets within
      // preview.mp4 — together they let us map current playback time back to
      // a "click here = jump to this moment in source" deep-link.
      var starts = (el.dataset.hotShotsStarts || '').split(',')
        .map(parseFloat).filter(isFinite);
      var cums = (el.dataset.hotShotsCums || '').split(',')
        .map(parseFloat).filter(isFinite);
      var link = el.closest('a');
      var linkBase = link ? link.getAttribute('href') : null;
      var active = false;
      var previewUrl = base + '/preview.mp4';

      function clipIndexAt(t) {
        for (var i = cums.length - 1; i >= 0; i--) {
          if (t >= cums[i]) return i;
        }
        return 0;
      }

      function syncHref() {
        if (!link || !linkBase) return;
        var s = starts[clipIndexAt(video.currentTime)];
        if (!isFinite(s) || s <= 0) {
          link.setAttribute('href', linkBase);
        } else {
          link.setAttribute('href', linkBase + '?t=' + s.toFixed(2));
        }
      }

      video.addEventListener('timeupdate', syncHref);
      syncHref();

      return {
        start: function() {
          if (active) return;
          active = true;
          // Attach src on demand. preload="none" + a missing src means no
          // decoder/buffer is held until we actively play this card.
          if (!video.getAttribute('src')) video.src = previewUrl;
          var p = video.play();
          if (p && p.catch) p.catch(function(){});
        },
        stop: function() {
          if (!active) return;
          active = false;
          video.pause();
          // Free the decoder + any buffered video. Without this, scrolling
          // a 127-card gallery accumulates ~5-10MB per card in held state
          // and Safari reloads the tab when it crosses ~1GB.
          video.removeAttribute('src');
          video.load();
          syncHref();
        },
      };
    }

    // ── Viewport autoplay ──
    // Wait for window.load (posters + metadata settled) before enabling, with a
    // hard fallback so slow/stalled resources don't stop us forever.
    var autoplayArmed = false;
    function armViewportAutoplay() {
      if (autoplayArmed || cards.length === 0) return;
      autoplayArmed = true;

      if (!('IntersectionObserver' in window)) return;

      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          var card = cards.find(function(c) { return c.el === entry.target; });
          if (!card) return;
          if (entry.isIntersecting) card.handlers.start();
          else card.handlers.stop();
        });
      }, { threshold: 0.5 });

      cards.forEach(function(c) { observer.observe(c.el); });
    }

    if (document.readyState === 'complete') {
      armViewportAutoplay();
    } else {
      window.addEventListener('load', armViewportAutoplay);
      // Fallback — if 'load' hasn't fired within 2.5s (rare — a stalled request)
      // we still kick off, so the feed doesn't sit idle.
      setTimeout(armViewportAutoplay, 2500);
    }
  });
  ${"<"}/script>`;
}

// ─── Template: Shell ─────────────────────────────────────────────────────────

function shell(title, body, { isDetail = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${isDetail ? "../../" : ""}style.css">
  <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.0-beta.11/bundles/datastar.js"></script>
</head>
<body>
  ${body}
  ${videoPlayerScript()}
</body>
</html>`;
}

// ─── Template: Nav Bar ───────────────────────────────────────────────────────

function navBar(isDetail = false) {
  const prefix = isDetail ? "../../" : "";
  return `
  <nav class="nav-top">
    <a href="${prefix}index.html" class="nav-logo">
      <svg class="ig-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
      <span class="logo-text">vig</span>
    </a>
    <div class="nav-icons">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24">
        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
      </svg>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24">
        <path d="M3 6h18M3 12h18M3 18h18"/>
      </svg>
    </div>
  </nav>`;
}

function navBottom(isDetail = false, activeHome = true) {
  const prefix = isDetail ? "../../" : "";
  return `
  <nav class="nav-bottom">
    <a href="${prefix}index.html" class="nav-bottom-item${activeHome ? " active" : ""}">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    </a>
    <a class="nav-bottom-item">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    </a>
    <a class="nav-bottom-item">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>
    </a>
    <a class="nav-bottom-item">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
    </a>
    <a class="nav-bottom-item">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
    </a>
  </nav>`;
}

// ─── Template: Stories Bar ───────────────────────────────────────────────────
// Unique top-level folders act as "collections" — replaces IG's author stories.

function storiesBar(posts) {
  const seen = new Set();
  const collections = [];
  for (const p of posts) {
    const top = p.folder ? p.folder.split("/")[0] : "root";
    if (!seen.has(top)) {
      seen.add(top);
      collections.push({ label: top, firstSlug: p.slug });
    }
  }

  const items = collections
    .map((c) => {
      const display = c.label.length > 10 ? c.label.slice(0, 9) + "…" : c.label;
      const initial = c.label[0]?.toUpperCase() || "?";
      return `
      <a href="post/${c.firstSlug}/index.html" class="story-item">
        <div class="story-ring">
          <div class="story-avatar-placeholder">${escapeHtml(initial)}</div>
        </div>
        <span class="story-username">${escapeHtml(display)}</span>
      </a>`;
    })
    .join("");

  return `<div class="stories-bar">${items}</div>`;
}

// ─── Template: View Toggle ───────────────────────────────────────────────────

function viewToggle() {
  return `
  <div class="view-toggle">
    <button class="toggle-btn" data-class-active="!$gallery" data-on-click="$gallery = false">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
    </button>
    <button class="toggle-btn" data-class-active="$gallery" data-on-click="$gallery = true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 3h7v7H3zm0 11h7v7H3zm11-11h7v7h-7zm0 11h7v7h-7z"/></svg>
    </button>
  </div>`;
}

// ─── Template: Feed Card ─────────────────────────────────────────────────────

function feedCard(post, index) {
  const folder = folderLabel(post.folder);
  const starts = post.previewPlan ? post.previewPlan.ranges.map((r) => r.start) : [];
  const cums = previewCums(post.previewPlan);
  const mediaHtml = post.hasThumb
    ? hotShots(`post/${post.slug}`, post.title, "feed", post.previewCount || 1, starts, cums)
    : `<div class="post-media no-media"><div class="grid-placeholder">${escapeHtml(folderInitial(post.folder))}</div></div>`;

  return `
  <article class="post-card">
    <!-- Header -->
    <a href="post/${post.slug}/index.html" class="post-header">
      <div class="avatar-sm">${escapeHtml(folderInitial(post.folder))}</div>
      <div class="post-header-info">
        <span class="username">${escapeHtml(folder)}</span>
        <span class="post-time">${timeAgo(post.mtime)}</span>
      </div>
      <span class="post-menu">•••</span>
    </a>

    <!-- Media -->
    <a href="post/${post.slug}/index.html" class="post-media-link">
      ${mediaHtml}
    </a>

    <!-- Title (filename) -->
    <div class="post-caption">
      <span class="username">${escapeHtml(folder)}</span>
      <span>${escapeHtml(post.title)}</span>
    </div>

    <!-- Meta -->
    <div class="post-meta-inline">
      <span>${formatBytes(post.size)}</span>
    </div>
  </article>`;
}

// Hot-shots preview. Every card is a <video> with a poster; JS plays the first
// clip when the card enters the viewport (or on hover) and switches src to cycle
// through NN.mp4. Single-clip cards loop natively via video.loop in JS.
// `starts` is the list of clip start-seconds in the source video — the JS writes
// the current start onto the wrapping <a href> as ?t=<seconds> so clicking
// jumps to that moment on the detail page.
function hotShots(baseUrl, title, variant, count, starts = [], cums = []) {
  const poster = `${baseUrl}/poster.jpg`;
  const startsAttr = starts.map((s) => s.toFixed(2)).join(",");
  const cumsAttr = cums.map((s) => s.toFixed(2)).join(",");
  // The video element starts WITHOUT a src — only the poster is shown.
  // setupClipCycle attaches the src on viewport entry and clears it again
  // on exit (via removeAttribute + load()) to free the decoder context.
  // Keeps memory bounded for big galleries — 127 always-loaded <video>
  // elements with preload="metadata" easily blow past Safari's tab limit.
  return `<div class="hot-shots hot-shots-${variant}"
              data-hot-shots="${baseUrl}"
              data-hot-shots-count="${count}"
              data-hot-shots-starts="${startsAttr}"
              data-hot-shots-cums="${cumsAttr}"
              aria-label="${escapeHtml(title)}">
    <video class="hot-shots-video"
           poster="${poster}"
           playsinline preload="none" muted loop></video>
  </div>`;
}

// ─── Template: Detail Page ───────────────────────────────────────────────────

function detailPage(post) {
  const src = post.videoFile;                                  // relative to detail page
  const poster = post.hasThumb ? "poster.jpg" : "";
  // Safe-for-inline JSON: escape </ so a shot label can never close the <script> tag.
  const initialShotsJson = JSON.stringify(post.shots || []).replace(/</g, "\\u003c");

  return shell(
    `${post.title} — vig`,
    `
    <main class="vig-detail">
      <vig-player
        src="${src}"
        ${poster ? `poster="${poster}"` : ""}
        center-action="back"
        back-href="../../index.html"
        autoplay
        muted
        data-slug="${post.slug}">
        <script type="application/json" slot="shots">${initialShotsJson}</script>
      </vig-player>
    </main>
    <script type="module" src="../../vig-player.js${globalThis.__vigPlayerVersion ? `?v=${globalThis.__vigPlayerVersion}` : ""}"></script>`,
    { isDetail: true }
  );
}

// ─── Template: Gallery Grid ──────────────────────────────────────────────────

function galleryGrid(posts) {
  // Three cell sizes for visual rhythm in a max-3-col grid:
  //   - Vertical (h > w):                       1 col × 2 rows  (portrait)
  //   - Horizontal w/ slugHash%8 == 0 (~12%):   2 cols × 2 rows (big square)
  //   - Other horizontal:                       1 col × 1 row   (small square)
  // Hash is deterministic on slug so the same video always gets the same shape.
  // grid-auto-flow: dense (set on the container) packs the mix efficiently.
  const cells = posts
    .map((post) => {
      const isVertical = post.dimensions && post.dimensions.h > post.dimensions.w;
      const isBig = !isVertical && (slugHash(post.slug) % 8 === 0);
      let spanStyle = "";
      if (isVertical) spanStyle = ' style="grid-row: span 2"';
      else if (isBig) spanStyle = ' style="grid-column: span 2; grid-row: span 2"';

      const starts = post.previewPlan ? post.previewPlan.ranges.map((r) => r.start) : [];
      const cums = previewCums(post.previewPlan);
      const thumb = post.hasThumb
        ? hotShots(`post/${post.slug}`, post.title, "grid", post.previewCount || 1, starts, cums)
        : `<div class="grid-placeholder">${escapeHtml(folderInitial(post.folder))}</div>`;
      return `
      <a href="post/${post.slug}/index.html" class="grid-cell"${spanStyle}>
        ${thumb}
        <div class="grid-overlay">
          <span class="grid-stat">${escapeHtml(post.title)}</span>
        </div>
      </a>`;
    })
    .join("");

  return `<div class="gallery-grid">${cells}</div>`;
}

// ─── Template: Feed (index.html) ─────────────────────────────────────────────

function feedPage(posts) {
  if (posts.length === 0) {
    return shell(
      "vig",
      `
      ${navBar()}
      <main class="feed empty-state">
        <div class="empty-inner">
          <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.2">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
          <h2>No videos yet</h2>
          <p>Drop <code>.mp4</code>, <code>.mov</code>, <code>.webm</code>, or <code>.m4v</code> files into the <code>${CONTENT_DIR}/</code> folder (nested folders are fine) and rebuild.</p>
        </div>
      </main>
      ${navBottom(false)}`
    );
  }

  const cards = posts.map((p, i) => feedCard(p, i)).join("\n");

  return shell(
    "vig",
    `
    <div data-signals-gallery="false">
    ${navBar()}
    ${storiesBar(posts)}
    ${viewToggle()}
    <main class="feed" data-show="!$gallery">
      ${cards}
    </main>
    <main class="gallery-main" data-show="$gallery">
      ${galleryGrid(posts)}
    </main>
    </div>
    ${navBottom(false)}`
  );
}

// ─── Build ───────────────────────────────────────────────────────────────────

async function build() {
  console.log("Building vig…");

  // 1. Verify content dir.
  // Auto-create only relative paths (the project-local "videos/" default);
  // an absolute external source must already exist — silently creating it
  // somewhere unexpected would mask a misconfiguration.
  if (!existsSync(CONTENT_DIR)) {
    if (CONTENT_DIR.startsWith("/")) {
      console.error(`Content directory not found: ${CONTENT_DIR}`);
      console.error("Set VIG_VIDEOS or check the path.");
      process.exit(1);
    }
    await mkdir(CONTENT_DIR, { recursive: true });
    console.log(`  Created empty ${CONTENT_DIR}/`);
  }

  // 2. Walk videos recursively
  const videos = await walkVideos(CONTENT_DIR);

  const posts = videos.map((v) => {
    const stem = v.filename.replace(/\.[^.]+$/, "");
    const slug = slugify((v.folder ? v.folder.replace(/\//g, "-") + "-" : "") + stem);
    return {
      ...v,
      title: titleFromFilename(v.filename),
      slug,
      outDir: postOutDir(slug),
      metaDir: metaOutDir(slug),
      videoFile: videoFileName(v.filename),
      hasThumb: false,
      // sidecars filled in below
      shots: [],
      sidecarMtime: 0,
      heat: null,
      heatMtime: 0,
    };
  });

  // Ensure slug uniqueness (very defensive — append counter on collision).
  const seenSlugs = new Map();
  for (const p of posts) {
    const count = seenSlugs.get(p.slug) || 0;
    if (count > 0) {
      p.slug = `${p.slug}-${count}`;
      p.outDir = postOutDir(p.slug);
      p.metaDir = metaOutDir(p.slug);
    }
    seenSlugs.set(p.slug, count + 1);
  }

  // Load sidecars per post in parallel — pure I/O, sequential just adds latency.
  // They live in _site/meta/<slug>/ so a wipe of the post/ tree (full rebuild)
  // doesn't lose the user's shots and heat data.
  await Promise.all(posts.map(async (post) => {
    const shotsPath = join(post.metaDir, "shots.json");
    if (existsSync(shotsPath)) {
      try {
        const [raw, sst] = await Promise.all([readFile(shotsPath, "utf-8"), stat(shotsPath)]);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          post.shots = parsed.filter((s) =>
            typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start);
        }
        post.sidecarMtime = sst.mtime.getTime();
      } catch (err) {
        console.warn(`  skipping malformed shots ${shotsPath}: ${err.message}`);
      }
    }
    const heatPath = join(post.metaDir, "heat.json");
    if (existsSync(heatPath)) {
      try {
        const [raw, hst] = await Promise.all([readFile(heatPath, "utf-8"), stat(heatPath)]);
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.buckets) && typeof parsed.bucketSize === "number") {
          post.heat = parsed;
          post.heatMtime = hst.mtime.getTime();
        }
      } catch (err) {
        console.warn(`  skipping malformed heat ${heatPath}: ${err.message}`);
      }
    }
  }));

  // Sort newest first
  posts.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

  console.log(`  Found ${posts.length} video${posts.length === 1 ? "" : "s"}`);

  // 3. Create output dirs.
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(join(OUT_DIR, POST_DIR), { recursive: true });
  await mkdir(META_ROOT, { recursive: true });
  // Ensure each post has its meta dir (so the API can validate against it
  // even before any shots/heat have been recorded).
  for (const post of posts) await mkdir(post.metaDir, { recursive: true });

  // 3b. One-shot cleanup of the previous layout — _site/media/ and _site/thumbs/
  // were used before everything moved into _site/post/<slug>/. Just delete them
  // if present so disk doesn't bloat with orphaned files from old builds.
  for (const old of ["media", "thumbs"]) {
    const oldDir = join(OUT_DIR, old);
    if (existsSync(oldDir)) {
      await rm(oldDir, { recursive: true, force: true });
      console.log(`  removed legacy ${oldDir}`);
    }
  }

  // 4. Hardlink each source video to its post's outDir as video.<ext>.
  //    Hardlinks share inodes with the source — zero disk duplication, builds
  //    are instant, and the files look like regular files to the static server
  //    (unlike symlinks, which serve refuses when they point outside the root).
  //    Done in parallel: pure I/O, no reason to serialise.
  const linkResults = await Promise.all(posts.map(async (post) => {
    const srcPath = join(CONTENT_DIR, post.relPath);
    if (!existsSync(srcPath)) return "missing";
    await mkdir(post.outDir, { recursive: true });
    const destPath = join(post.outDir, post.videoFile);

    try {
      const [destStat, srcStat] = await Promise.all([lstat(destPath), stat(srcPath)]);
      if (!destStat.isSymbolicLink() && destStat.ino === srcStat.ino) return "skipped";
      await rm(destPath, { force: true });
    } catch { /* doesn't exist — fine */ }

    try {
      await link(srcPath, destPath);
      return "linked";
    } catch {
      // Hardlinks can't cross filesystems (EXDEV) or may be unsupported — fall back to copy.
      await copyFile(srcPath, destPath);
      return "copied";
    }
  }));
  if (posts.length > 0) {
    const counts = { linked: 0, skipped: 0, copied: 0, missing: 0 };
    for (const r of linkResults) counts[r] = (counts[r] || 0) + 1;
    const parts = [];
    if (counts.linked)  parts.push(`${counts.linked} linked`);
    if (counts.skipped) parts.push(`${counts.skipped} up-to-date`);
    if (counts.copied)  parts.push(`${counts.copied} copied (no symlink support)`);
    if (counts.missing) parts.push(`${counts.missing} missing source`);
    console.log(`  media: ${parts.join(", ")}`);
  }

  // 5. Generate poster + clip previews via ffmpeg, into each post's outDir.
  //    Gracefully no-ops when ffmpeg isn't installed.
  if (posts.length > 0) {
    await generateThumbs(posts);
  }

  // 5b. Write per-post meta.json — keeps each post folder self-contained even
  //     if you copy/move/share it without the source. Parallel: pure I/O.
  await Promise.all(posts.map((post) => writeFile(
    join(post.outDir, "meta.json"),
    JSON.stringify({
      slug: post.slug,
      originalName: post.filename,
      relPath: post.relPath,
      folder: post.folder,
      title: post.title,
      videoFile: post.videoFile,
      size: post.size,
      mtime: post.mtime,
    }, null, 2),
  )));

  // 6. Link the vig-player web component into _site/ so detail pages can load
  //    it as a same-origin module (file:// + cross-dir module loading is fragile,
  //    and the static server only serves _site). Capture the source mtime so
  //    detail pages can cache-bust the import URL on player updates.
  let playerVersion = "";
  if (existsSync(PLAYER_SRC)) {
    const dest = join(OUT_DIR, "vig-player.js");
    const s = await stat(PLAYER_SRC);
    playerVersion = String(Math.floor(s.mtimeMs));
    let stale = true;
    try {
      const d = await lstat(dest);
      if (!d.isSymbolicLink() && s.ino === d.ino) stale = false;
      else if (d.mtime.getTime() >= s.mtime.getTime()) stale = false;
    } catch { /* dest doesn't exist */ }
    if (stale) {
      await rm(dest, { force: true });
      try { await link(PLAYER_SRC, dest); }
      catch { await copyFile(PLAYER_SRC, dest); }
      console.log("  linked vig-player.js");
    }
  } else {
    console.warn(`  vig-player.js not found at ${PLAYER_SRC} — detail pages won't have the player`);
  }

  // Make the version available to detailPage() via a closure-y global.
  globalThis.__vigPlayerVersion = playerVersion;

  // 7. Write CSS
  await writeFile(join(OUT_DIR, "style.css"), CSS);
  console.log("  wrote style.css");

  // 8. Write feed page
  await writeFile(join(OUT_DIR, "index.html"), feedPage(posts));
  console.log("  wrote index.html");

  // 9. Write detail pages — each into its own post folder. Parallel: pure I/O.
  await Promise.all(posts.map(async (post) => {
    await mkdir(post.outDir, { recursive: true });
    await writeFile(join(post.outDir, "index.html"), detailPage(post));
  }));
  if (posts.length > 0) {
    console.log(`  wrote ${posts.length} detail page${posts.length === 1 ? "" : "s"}`);
  }

  // 10. Cleanup orphan post entries. Folders left over from previous builds
  //     against a different source folder, plus any stray files at the post
  //     root (e.g. an earlier slug-empty bug that wrote video.mp4 there).
  const validSlugs = new Set(posts.map((p) => p.slug));
  try {
    const entries = await readdir(join(OUT_DIR, POST_DIR), { withFileTypes: true });
    let orphans = 0;
    for (const entry of entries) {
      const p = join(OUT_DIR, POST_DIR, entry.name);
      if (entry.isDirectory()) {
        if (!validSlugs.has(entry.name)) {
          await rm(p, { recursive: true, force: true });
          orphans++;
        }
      } else {
        // Anything that isn't a slug-folder is junk: remove.
        await rm(p, { force: true });
        orphans++;
      }
    }
    if (orphans > 0) console.log(`  cleaned ${orphans} orphan post entr${orphans === 1 ? "y" : "ies"}`);
  } catch { /* post root missing — nothing to clean */ }

  console.log(`\nDone. Built ${posts.length} post${posts.length === 1 ? "" : "s"} → ${OUT_DIR}/`);
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `/* vig — Video Gallery Styles (mirrors mig's dark IG-style theme) */
:root {
  --bg: #000;
  --bg-card: #000;
  --bg-elevated: #1a1a1a;
  --text: #f5f5f5;
  --text-secondary: #a8a8a8;
  --text-tertiary: #737373;
  --border: #262626;
  --accent: #0095f6;
  --white: #fff;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --max-w: 470px;
  --feed-card-max: 470px;
  /* Grid has its own breakpoints — chrome (top nav, stories, view toggle,
     bottom nav, feed) stays in the 470px mobile-app frame for a focused look,
     while the grid breaks out to a cinematic content area on bigger viewports. */
  --grid-cols: 2;
  --nav-h: 54px;
  --bottom-h: 50px;
}

/* Grid column count: max 3 wide. Cells get bigger on wider viewports rather
   than more numerous — gives a less dense, more curated feel. */
@media (min-width: 720px) { :root { --grid-cols: 3; } }

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

a { color: inherit; text-decoration: none; }
button { background: none; border: none; cursor: pointer; color: inherit; font: inherit; }
img, video { display: block; width: 100%; height: auto; }

/* ─── Top Nav ─────────────────────────────────────────── */
.nav-top {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--nav-h);
  padding: 0 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  max-width: var(--max-w);
  margin: 0 auto;
}
.nav-logo { display: flex; align-items: center; gap: 8px; }
.ig-logo { width: 28px; height: 28px; }
.logo-text {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.5px;
  font-style: italic;
}
.nav-icons { display: flex; gap: 16px; color: var(--text); }
.nav-icons svg { cursor: pointer; }

/* ─── Stories Bar ─────────────────────────────────────── */
.stories-bar {
  display: flex;
  gap: 16px;
  padding: 12px 16px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid var(--border);
  max-width: var(--max-w);
  margin: 0 auto;
}
.stories-bar::-webkit-scrollbar { display: none; }
.story-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.story-ring {
  width: 62px;
  height: 62px;
  border-radius: 50%;
  background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.story-ring img,
.story-ring .story-avatar-placeholder {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 3px solid var(--bg);
  object-fit: cover;
}
.story-avatar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 600;
  font-size: 20px;
}
.story-username {
  font-size: 11px;
  color: var(--text);
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

/* ─── Feed ────────────────────────────────────────────── */
.feed {
  max-width: var(--max-w);
  margin: 0 auto;
  padding-bottom: calc(var(--bottom-h) + 20px);
}

/* ─── Post Card ───────────────────────────────────────── */
/* Cards stay narrow even when .feed grows on desktop — keeps 9:16 portrait
   videos at a watchable size instead of dominating the viewport. */
.post-card {
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
  margin: 0 auto 4px;
  max-width: var(--feed-card-max);
}
.post-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  gap: 10px;
}
.avatar-sm {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
  color: var(--text);
}
.post-header-info {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.username {
  font-weight: 600;
  font-size: 13px;
}
.post-time {
  font-size: 12px;
  color: var(--text-tertiary);
}
.post-menu {
  font-size: 16px;
  letter-spacing: 2px;
  color: var(--text);
}

/* ─── Media ───────────────────────────────────────────── */
.post-media {
  position: relative;
  background: var(--bg-elevated);
  max-height: 600px;
  overflow: hidden;
}
.post-media img,
.post-media video {
  width: 100%;
  max-height: 600px;
  object-fit: contain;
  background: #000;
}

/* ─── Hot-shots Preview ───────────────────────────────── */
/* Card shape comes from CSS, not inline. Feed cards are uniformly 9:16 so
   verticals fit naturally and horizontals get cropped to the same height.
   Grid cells are square base-units, with verticals spanning two rows. */
.hot-shots {
  position: relative;
  width: 100%;
  background-color: #000;
  cursor: pointer;
  overflow: hidden;
}
.hot-shots-feed {
  aspect-ratio: 9 / 16;
}
.hot-shots-grid {
  width: 100%;
  height: 100%;
}
.hot-shots-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;   /* horizontals crop into 9:16; verticals fit perfectly */
  display: block;
}
/* ─── Caption / Title ─────────────────────────────────── */
.post-caption {
  padding: 8px 12px 0;
  font-size: 14px;
  line-height: 1.4;
}
.post-caption .username {
  margin-right: 5px;
}
.post-meta-inline {
  padding: 4px 12px 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ─── Bottom Nav ──────────────────────────────────────── */
.nav-bottom {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--max-w);
  height: var(--bottom-h);
  background: var(--bg);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-around;
  z-index: 100;
}
.nav-bottom-item {
  color: var(--text);
  opacity: 0.6;
  transition: opacity 0.15s;
}
.nav-bottom-item.active { opacity: 1; }

/* ─── Detail Page (vig-player host) ───────────────────── */
.vig-detail {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 1;
}
.vig-detail vig-player {
  width: 100%;
  height: 100%;
}

/* ─── View Toggle ─────────────────────────────────────── */
.view-toggle {
  display: flex;
  justify-content: center;
  gap: 0;
  max-width: var(--max-w);
  margin: 0 auto;
  border-bottom: 1px solid var(--border);
}
.toggle-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0;
  color: var(--text-tertiary);
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
  transition: color 0.2s, border-color 0.2s;
}
.toggle-btn.active {
  color: var(--text);
  border-bottom-color: var(--text);
}

/* ─── Gallery Grid ─────────────────────────────────────────────────── */
/* Square base cell. Vertical → 1×2, horizontal → 2×1 (both natural shapes,
   no crops). The grid lives in .gallery-main which is NOT capped at the
   chrome's --max-w — so on desktop the grid spans the full browser window
   while the chrome (top nav, stories, view toggle, bottom nav, feed) stays
   in its 470px mobile-app frame. Minimal padding for true edge-to-edge feel.
   dense packing backfills holes left by 2-col-wide horizontals. */
.gallery-main {
  width: 100%;
  padding-bottom: calc(var(--bottom-h) + 24px);
}
.gallery-grid {
  --grid-gap: 2px;
  --grid-edge: 0px;
  /* Cap kicks in on desktop only — below this the grid fills the viewport
     edge-to-edge (iPad portrait, iPad landscape both look great full-width).
     Above, we cap and centre so cells don't grow absurdly large. */
  --grid-cap: 100vw;
  display: grid;
  grid-template-columns: repeat(var(--grid-cols), 1fr);
  /* Row height = column width. Subtract a 17px fudge for the scrollbar so the
     grid never overflows horizontally. min() lets the formula adapt to either
     the viewport (mobile) or the cap (desktop). */
  grid-auto-rows: calc(
    (min(100vw, var(--grid-cap)) - 17px - 2 * var(--grid-edge) - (var(--grid-cols) - 1) * var(--grid-gap))
    / var(--grid-cols)
  );
  grid-auto-flow: dense;
  gap: var(--grid-gap);
  width: 100%;
  max-width: var(--grid-cap);
  margin: 0 auto;
  padding: 0 var(--grid-edge);
}
@media (min-width: 1100px) {
  .gallery-grid { --grid-cap: 1100px; }
}
.grid-cell {
  position: relative;
  background: var(--bg-elevated);
  overflow: hidden;
}
.grid-cell .grid-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 700;
  color: var(--text-tertiary);
  background: var(--bg-elevated);
}
.grid-icon {
  position: absolute;
  top: 8px;
  right: 8px;
  filter: drop-shadow(0 1px 3px rgba(0,0,0,0.5));
}
.grid-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 50%);
  display: flex;
  align-items: flex-end;
  padding: 8px;
  opacity: 0;
  transition: opacity 0.15s;
}
.grid-cell:hover .grid-overlay { opacity: 1; }
.grid-stat {
  color: white;
  font-weight: 600;
  font-size: 11px;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

/* ─── Empty State ─────────────────────────────────────── */
.empty-state {
  min-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 24px;
}
.empty-inner {
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.empty-inner svg { color: var(--text-tertiary); }
.empty-inner h2 {
  color: var(--text);
  font-size: 20px;
  font-weight: 600;
  margin-top: 4px;
}
.empty-inner p { font-size: 14px; line-height: 1.5; max-width: 320px; }
.empty-inner code {
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}

/* ─── Responsive ──────────────────────────────────────── */
@media (min-width: 480px) {
  /* Mobile-app frame outline for the chrome and feed — NOT the grid, which
     breaks out to full browser width. */
  .feed, .detail-page, .nav-top, .stories-bar, .view-toggle {
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }
}
`;

// ─── Run ─────────────────────────────────────────────────────────────────────
build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
