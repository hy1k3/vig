# vig

Personal video gallery. Point it at a folder of videos, get a browseable site with TikTok-style previews, deep-linkable shots, watch heatmaps, and an in-place clip-marking player.

## Install

One-time, somewhere on your `$PATH`:

```sh
curl -o ~/bin/vig https://raw.githubusercontent.com/hy1k3/vig/main/install.sh
chmod +x ~/bin/vig
```

## Use

```sh
cd ~/Movies
vig
# vig: cloning https://github.com/hy1k3/vig.git into ~/Movies/.vig/src   (first time only)
# vig: building…
# vig: serving ~/Movies
#      http://localhost:53412
```

Open the URL in your browser. Stop with Ctrl+C.

Going forward you can either:

- `vig` (the global script — auto-updates the local clone), or
- `~/Movies/.vig/vig.sh` (the local launcher dropped on first run — doesn't update; useful if you don't want to be surprised by changes).

## What gets created

```
~/Movies/
├── film1.mp4
├── film2.mp4
└── .vig/
    ├── src/        # cloned vig source (rebuildable: rm and re-run vig)
    ├── site/       # generated build output: html, css, posters, clips
    ├── meta/       # persistent user data: shots.json, heat.json per video
    └── vig.sh      # local launcher, see above
```

The source folder itself is never modified — vig only ever reads from it.

## Update vig

```sh
rm -rf ~/Movies/.vig/src     # forces re-clone of latest on next run
vig
```

Or just run `vig` (not `.vig/vig.sh`) — the global script does `git pull` automatically.

## Develop

```sh
git clone https://github.com/hy1k3/vig.git
cd vig
npm run dev               # build + serve in this folder
npm run dev:debug         # also logs every ffmpeg call
```

Override paths with env vars:

| var               | default                           | what it sets                                          |
| ----------------- | --------------------------------- | ----------------------------------------------------- |
| `VIG_VIDEOS`      | `process.cwd()`                   | source folder (read-only)                             |
| `VIG_SITE`        | `_site`                           | build output (html, posters, clips)                   |
| `VIG_META`        | `<VIG_SITE>/meta`                 | persistent shots/heat sidecars                        |
| `VIG_PLAYER_SRC`  | `<vig-install>/vig-player.js`     | path to the `<vig-player>` web component              |
| `VIG_PORT`        | `3001` (cli picks a free port)    | server port                                           |
| `VIG_DEBUG`       | unset                             | log every ffmpeg call when `=1`                       |

## Requirements

- Node 20 or newer (uses `fs.watch` recursive on Linux)
- `ffmpeg` and `ffprobe` on `$PATH` (`brew install ffmpeg`)
- `git` (for the bootstrap script)

## License

MIT
