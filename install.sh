#!/usr/bin/env bash
# Link the wipline commands into ~/.local/bin (or $WIPLINE_BIN).
set -uo pipefail

die() { echo "install: $*" >&2; exit 1; }

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bin="${WIPLINE_BIN:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || die "node is required (20+)"
command -v git >/dev/null 2>&1 || die "git is required"

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || die "node 20+ is required, found $(node -v)"

mkdir -p "$bin"
chmod +x "$root/bin/wipline.mjs" "$root/bin/wipline-tui.mjs" "$root/bin/wipline-pane.sh"

ln -sf "$root/bin/wipline.mjs"      "$bin/wipline"
ln -sf "$root/bin/wipline-tui.mjs"  "$bin/wipline-tui"
ln -sf "$root/bin/wipline-pane.sh"  "$bin/wipline-pane"

echo "linked into $bin:"
echo "  wipline        record and read phases"
echo "  wipline-tui    the interactive pane"
echo "  wipline-pane   toggle it in a herdr split"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo; echo "note: $bin is not on your PATH" ;;
esac
