#!/usr/bin/env sh
# vig — bootstrap a video gallery in the current folder.
#
# Usage (one-time): copy this file to ~/bin/vig and chmod +x.
# Then: cd ~/some-folder-with-videos  &&  vig
#
# What it does:
#   1. Clones (or pulls latest) https://github.com/hy1k3/vig.git into .vig/src/
#   2. Drops a local .vig/vig.sh launcher (so you can run vig from this folder
#      later even without the global script).
#   3. Runs `node .vig/src/cli.js` against the current folder.

set -e
REPO="https://github.com/hy1k3/vig.git"
VIG_DIR="$PWD/.vig"
SRC="$VIG_DIR/src"

mkdir -p "$VIG_DIR"

if [ -d "$SRC/.git" ]; then
  # Best-effort update; ignore network errors so offline use still works.
  git -C "$SRC" pull --quiet --rebase origin main 2>/dev/null || true
else
  echo "vig: cloning $REPO into $SRC"
  git clone --quiet --depth 1 "$REPO" "$SRC"
fi

# Local launcher — so this folder remembers how to run vig even if the global
# script is gone. Rewriting on each run keeps it in sync with any updates.
cat > "$VIG_DIR/vig.sh" <<'EOF'
#!/usr/bin/env sh
# Local vig launcher (auto-generated).
#   - Runs the cloned vig in .vig/src against this folder.
#   - Does NOT auto-update — to refresh: rm -rf .vig/src  (next launch re-clones).
exec node "$(dirname "$0")/src/cli.js" "$@"
EOF
chmod +x "$VIG_DIR/vig.sh"

exec node "$SRC/cli.js" "$@"
