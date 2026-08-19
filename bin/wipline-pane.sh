#!/usr/bin/env bash
# wipline-pane — toggle the wipline TUI in a herdr pane beside the focused one.
#
#   wipline-pane.sh          toggle (open if absent, close if present)
#   wipline-pane.sh open
#   wipline-pane.sh close
#
# herdr (https://github.com/persiyanov/herdr) only. Without it the TUI still runs
# in any terminal: just `wipline-tui`.
#
# Prints KEY=value: STATUS=opened|closed|absent, PANE=<id> when one exists.
#
# The open pane is remembered in a state file keyed by TAB — a pane carries no
# label and `pane rename` leaves `terminal_title` null, so there is nothing on the
# pane itself to recognise ours by.
set -uo pipefail

die() { echo "wipline-pane: $*" >&2; exit 1; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root_dir=$(cd -- "$script_dir/.." && pwd)
H="${HERDR_BIN_PATH:-herdr}"
LABEL="wipline"

command -v "$H" >/dev/null 2>&1 || { echo "STATUS=absent"; echo "REASON=herdr not installed"; exit 0; }

panes_json=$("$H" pane list 2>/dev/null) || { echo "STATUS=absent"; echo "REASON=herdr not running"; exit 0; }
[ -n "$panes_json" ] || { echo "STATUS=absent"; echo "REASON=no panes"; exit 0; }

# `cwd` is the pane's spawn directory, which for every agent here is the workspace
# root — never the worktree the session moved into via EnterWorktree. So the task
# would resolve to the main checkout's branch. `foreground_cwd` is the live path.
read -r workspace_id focused_tab focused_pane focused_cwd <<EOF
$(printf '%s' "$panes_json" | /usr/bin/python3 -c '
import json, sys
panes = json.load(sys.stdin)["result"]["panes"]
focused = next((p for p in panes if p.get("focused")), None)
if focused:
    live = focused.get("foreground_cwd") or focused.get("cwd") or ""
    print(focused["workspace_id"], focused.get("tab_id") or "", focused["pane_id"], live)
')
EOF
[ -n "${workspace_id:-}" ] || { echo "STATUS=absent"; echo "REASON=no focused pane"; exit 0; }

# A pane carries no label and `pane rename` leaves `terminal_title` null, so there
# is nothing on the pane itself to recognise ours by — the id goes in a state file
# instead.
#
# Keyed by TAB, not workspace: a workspace here is a project and a tab is a task,
# so keying by workspace made every task share one entry — opening the pane in one
# task closed it in another, because toggle recognised that pane as its own.
state_home="${WIPLINE_STATE_DIR:-$HOME/.local/state/wipline}"
key=$(printf '%s' "${focused_tab:-$workspace_id}" | tr -c 'A-Za-z0-9_.-' '_')
state_file="$state_home/pane.$key"
mkdir -p "$(dirname "$state_file")"

# Self-healing on two counts: an id no longer in `pane list` (closed by hand), and
# one that has drifted to another tab (herdr moved it) — neither is ours to close.
existing=""
if [ -f "$state_file" ]; then
  remembered=$(cat "$state_file" 2>/dev/null)
  if [ -n "$remembered" ] && printf '%s' "$panes_json" | jq -e \
      --arg p "$remembered" --arg t "${focused_tab:-}" \
      '.result.panes[] | select(.pane_id == $p) | select($t == "" or .tab_id == $t)' \
      >/dev/null 2>&1; then
    existing="$remembered"
  else
    rm -f "$state_file"
  fi
fi

close_existing() {
  local closed=""
  if [ -n "$existing" ]; then
    "$H" pane close "$existing" >/dev/null 2>&1 && closed="$existing"
  fi
  rm -f "$state_file"
  printf '%s' "$closed"
}

cmd=${1:-toggle}

case "$cmd" in
  close)
    if [ -n "$existing" ]; then
      closed=$(close_existing)
      echo "STATUS=closed"
      [ -n "$closed" ] && echo "PANE=$closed"
      exit 0
    fi
    echo "STATUS=absent"
    exit 0
    ;;
  toggle)
    if [ -n "$existing" ]; then
      closed=$(close_existing)
      echo "STATUS=closed"
      [ -n "$closed" ] && echo "PANE=$closed"
      exit 0
    fi
    ;;
  open)
    if [ -n "$existing" ]; then
      echo "STATUS=opened"
      echo "PANE=$existing"
      exit 0
    fi
    ;;
  *)
    die "usage: phase-pane.sh [toggle|open|close] (got '$cmd')"
    ;;
esac

# Which task the pane is about, so the TUI can open its phases instead of the
# picker. Two sources, in order: the branch of the pane's live cwd, then the herdr
# tab label, if your terminal names tabs after tasks. Neither found → no argument,
# and the TUI shows the board as a picker.
task=""
if [ -n "${focused_cwd:-}" ]; then
  branch=$(git -C "$focused_cwd" branch --show-current 2>/dev/null)
  task=$(printf '%s' "$branch" | grep -oE '[A-Z][A-Z0-9]*-[0-9]+' | head -1)
fi
if [ -z "$task" ]; then
  tab_label=$("$H" tab list 2>/dev/null | /usr/bin/python3 -c '
import json, sys
try:
    tabs = json.load(sys.stdin)["result"]["tabs"]
except Exception:
    sys.exit(0)
focused = next((t for t in tabs if t.get("focused")), None)
print((focused or {}).get("label") or "")
')
  task=$(printf '%s' "$tab_label" | grep -oE '[A-Z][A-Z0-9]*-[0-9]+' | head -1)
fi
# `--ratio` sizes the pane being SPLIT, not the new one — 0.32 gave the TUI the
# big two thirds. So compute it from the live area width to land a fixed column
# count, and hand that count to the TUI: inside a pane `process.stdout.columns`
# reports the whole window, so the TUI cannot measure itself.
TUI_COLS="${WIPLINE_COLS:-56}"
area_width=$("$H" pane layout --pane "$focused_pane" 2>/dev/null | /usr/bin/python3 -c '
import json, sys
try:
    print(json.load(sys.stdin)["result"]["layout"]["area"]["width"])
except Exception:
    print(0)
')
ratio=$(/usr/bin/python3 -c "
area = $area_width
cols = $TUI_COLS
if area <= 0:
    print('0.75')
else:
    # Clamped so a very narrow window still splits somewhere sane.
    print('%.3f' % min(0.9, max(0.4, 1 - cols / area)))
")
[ "$area_width" -gt 0 ] 2>/dev/null && TUI_COLS=$(/usr/bin/python3 -c "
print(max(40, min($TUI_COLS, int($area_width * (1 - $ratio)))))")

split_json=$("$H" pane split --pane "$focused_pane" --direction right --ratio "$ratio" \
  --cwd "$focused_cwd" --env "WIPLINE_WIDTH=$TUI_COLS" --no-focus 2>&1) ||
  die "pane split failed: $split_json"

pane=$(printf '%s' "$split_json" | jq -r '.result.pane.pane_id // .result.pane_id // empty')
[ -n "$pane" ] || die "pane split returned no pane: $split_json"

"$H" pane rename "$pane" "$LABEL" >/dev/null 2>&1
printf '%s\n' "$pane" > "$state_file"

# The split starts a shell; `exec` replaces it so closing the TUI closes the pane
# instead of dropping the user into a stray prompt in a 32%-wide column.
if [ -n "$task" ]; then
  "$H" pane run "$pane" exec node "$root_dir/bin/wipline-tui.mjs" "$task" >/dev/null 2>&1 ||
    die "could not start the TUI in $pane"
else
  "$H" pane run "$pane" exec node "$root_dir/bin/wipline-tui.mjs" >/dev/null 2>&1 ||
    die "could not start the TUI in $pane"
fi

echo "STATUS=opened"
echo "PANE=$pane"
[ -n "$task" ] && echo "TASK=$task"
echo "SCREEN=$([ -n "$task" ] && echo phases || echo board)"
