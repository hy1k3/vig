# vig

Personal video gallery. Point it at a folder of videos, get a browseable site with TikTok-style previews, deep-linkable shots, watch heatmaps, and an in-place clip-marking player.

## Use

```sh
cd ~/Movies
curl https://raw.githubusercontent.com/hy1k3/vig/main/vig.sh | sh
```

That's it. First run clones vig into `.vig/src/`, builds the gallery into `.vig/site/`, picks a free port, and serves it:

```
vig: cloning https://github.com/hy1k3/vig.git into ~/Movies/.vig/src
vig: building…
vig: serving ~/Movies
     http://localhost:53412
```

Open the URL. Stop with Ctrl+C.

**Subsequent runs in the same folder:**

```sh
.vig/vig.sh
```

The local launcher is dropped on first run — it doesn't auto-update, just runs whatever's in `.vig/src/`. Useful when you don't want to be surprised by new versions.

**Re-run the bootstrap** (auto-update + run) any time with the same `curl … | sh` line. If you do it often, save the script:

```sh
curl -o ~/vig.sh https://raw.githubusercontent.com/hy1k3/vig/main/vig.sh
chmod +x ~/vig.sh
# then anywhere:
cd ~/some-folder && ~/vig.sh
```

## What gets created

```
~/Movies/
├── film1.mp4
├── film2.mp4
└── .vig/
    ├── src/        # cloned vig source
    ├── site/       # generated build output (safe to wipe — full rebuild)
    ├── meta/       # persistent shots/heat sidecars (NOT wiped)
    └── vig.sh      # local launcher (no auto-update)
```

Your source folder is never modified — vig only reads from it.

## Update vig

```sh
rm -rf ~/Movies/.vig/src     # next launch re-clones latest
.vig/vig.sh
```

Or just re-run `curl … | sh` — the bootstrap does `git pull` on existing clones.

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
| `VIG_PORT`        | random free port (cli)            | server port                                           |
| `VIG_DEBUG`       | unset                             | log every ffmpeg call when `=1`                       |

## Requirements

- Node 20 or newer
- `ffmpeg` and `ffprobe` on `$PATH` (`brew install ffmpeg`)
- `git` (for the bootstrap)

## License

MIT
