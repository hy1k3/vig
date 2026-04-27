#!/usr/bin/env node
/**
 * Debug a single video's clip extraction. Replays the exact ffmpeg commands
 * the build would run, one shot at a time, with full ffmpeg stderr.
 *
 * Usage:
 *   node debug-clip.js <slug>
 *   node debug-clip.js <slug> --no-tune       # skip tune=grain
 *   node debug-clip.js <slug> --crf 28        # try a different CRF
 *   node debug-clip.js <slug> --seek-after    # use -ss AFTER -i (slow but reliable)
 *
 * Outputs to /tmp/vig-debug/<slug>/NN.mp4 — does NOT touch _site/.
 */

import { spawn } from "child_process";
import { readFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, extname } from "path";

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) {
  console.error("usage: node debug-clip.js <slug> [--no-tune] [--crf N] [--seek-after]");
  process.exit(1);
}

const noTune = args.includes("--no-tune");
const seekAfter = args.includes("--seek-after");
const crfArg = args[args.indexOf("--crf") + 1];
const customCrf = args.includes("--crf") ? parseInt(crfArg, 10) : null;

const META_PATH = resolve("_site/meta", slug);
const POST_PATH = resolve("_site/post", slug);
const OUT_DIR = `/tmp/vig-debug/${slug}`;

function spawnCapture(cmd, ar) {
  return new Promise((res) => {
    let out = "", err = "";
    const p = spawn(cmd, ar);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => res({ code: -1, out, err: "command not found" }));
    p.on("close", (code) => res({ code, out, err }));
  });
}

async function main() {
  if (!existsSync(POST_PATH)) {
    console.error(`post not found: ${POST_PATH}`);
    process.exit(1);
  }

  // 1. Find the source video — link via _site/post/<slug>/video.<ext>
  const meta = JSON.parse(await readFile(join(POST_PATH, "meta.json"), "utf-8"));
  const srcPath = meta.relPath
    ? resolve(process.env.VIG_VIDEOS || "/Users/hylkekleve/dwhelper", meta.relPath)
    : join(POST_PATH, meta.videoFile || "video.mp4");
  console.log(`source:   ${srcPath}`);
  console.log(`exists:   ${existsSync(srcPath)}`);

  // 2. Show source's basic info
  console.log("\n── source ffprobe ──");
  const probe = await spawnCapture("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames,start_time,duration,bit_rate",
    "-show_entries", "format=format_name,duration,bit_rate,start_time",
    "-of", "default",
    srcPath,
  ]);
  console.log(probe.out);

  // 3. Load shots
  let shots = [];
  const shotsPath = join(META_PATH, "shots.json");
  if (existsSync(shotsPath)) {
    shots = JSON.parse(await readFile(shotsPath, "utf-8"));
    console.log(`shots from ${shotsPath}:`);
    console.log(JSON.stringify(shots, null, 2));
  } else {
    console.log("no shots.json — using auto 20/40/60/80% (run build first to get correct ranges)");
    return;
  }

  // 4. Per-shot extraction with full ffmpeg output
  await mkdir(OUT_DIR, { recursive: true });
  const PREVIEW_SCALE = "scale=w='if(gt(iw,ih),-2,720)':h='if(gt(iw,ih),720,-2)'";
  const crf = customCrf ?? 20;
  const preset = "slow";

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const dur = Math.min(s.end - s.start, 8);
    const dest = join(OUT_DIR, `${String(i + 1).padStart(2, "0")}.mp4`);
    await rm(dest, { force: true });

    const seekArgs = seekAfter
      ? ["-i", srcPath, "-ss", String(s.start)]
      : ["-fflags", "+genpts", "-ss", String(s.start), "-i", srcPath];

    const ffmpegArgs = [
      "-y", "-loglevel", "info",
      ...seekArgs,
      "-t", String(dur),
      "-vf", PREVIEW_SCALE,
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", String(crf),
      ...(noTune ? [] : ["-tune", "grain"]),
      "-an",
      "-movflags", "+faststart",
      "-pix_fmt", "yuv420p",
      dest,
    ];

    console.log(`\n────── shot ${i + 1}/${shots.length} ──────`);
    console.log(`start=${s.start}  end=${s.end}  dur=${dur}`);
    console.log(`ffmpeg ${ffmpegArgs.join(" ")}`);
    const r = await spawnCapture("ffmpeg", ffmpegArgs);
    console.log(`exit:     ${r.code}`);
    console.log(`stderr (last 20 lines):`);
    console.log(r.err.split("\n").slice(-20).map((l) => "  " + l).join("\n"));

    if (r.code === 0 && existsSync(dest)) {
      const probeOut = await spawnCapture("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-count_packets",
        "-show_entries", "stream=nb_read_packets,duration",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=0",
        dest,
      ]);
      console.log(`output:`);
      console.log(probeOut.out.split("\n").map((l) => "  " + l).join("\n"));
    } else {
      console.log("(no output file produced)");
    }
  }

  console.log(`\nOutputs in: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("debug failed:", err);
  process.exit(1);
});
