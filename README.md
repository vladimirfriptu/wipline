# wipline

Tracks which phase of your pipeline each task has reached, in a terminal pane you
keep open, and lets your automation fill it in.

```
 TASKS IN FLIGHT
 ────────────────────────────────────────────────────
 ▸ ACME-2366  » dev          5/11
   ACME-2374  checks         9/11  ↻2
   ACME-2394  review         3/11
 ────────────────────────────────────────────────────
 ↑↓ move   enter open   r refresh   q quit
```

```
 ACME-2366
 ────────────────────────────────────────────────────
   PLANNING
   ✔ start          starting-a-task
   ✔ spec           Write
   ⊘ plan           skipped
   BUILD
 ▸ » dev            in progress
   ◐ checks         stale
   REVIEW
   ○ code-review
   ○ qa
   HANDOVER
   ○ mr
   ○ merged
   ○ cleanup
 ────────────────────────────────────────────────────
 next: dev   3/11
 ↑↓  space done  w wip  s skip  esc back  q quit
```

## Why

A development pipeline is easy to hold in your head for one task. With three or four
in flight it stops being easy: you come back to a branch after two days and cannot
remember whether you already ran the checks, whether review comments are waiting, or
whether you skipped the tests deliberately.

The usual answer is a ticket board, but a ticket has four or five statuses and your
actual pipeline has fifteen steps, most of which the board never sees. So the
knowledge lives in your head, and leaks.

wipline records those steps in an append-only journal, one file per task, and gives
you three ways to see it: a table, an interactive pane, and a one-line summary. The
point is not the pane. **The point is that most of the steps record themselves** —
see [Wiring the automation](#wiring-the-automation), which is the part that makes
this worth installing.

## Install

```bash
git clone https://github.com/vladimirfriptu/wipline ~/wipline
cd ~/wipline && ./install.sh
```

Links `wipline`, `wipline-tui` and `wipline-pane` into `~/.local/bin`. Node 20+ and
git are the only requirements. Nothing is written outside `~/.local/bin` and your
state directory.

## The model

**Fifteen phases or five — you decide.** The phase list lives in config, and the
default is a worked example rather than a recommendation.

A phase carries one of six states:

| state | meaning |
|---|---|
| *(none)* | not recorded in this round |
| `wip` | being worked on right now — set by hand |
| `done` | finished |
| `skip` | not needed this round |
| `open` | it ran, but left something outstanding (review findings, a red suite) |
| — | `clear` and `reset` are events that *unrecord*, not states you land in |

`done` and `skip` both count as passed. `wip` and `open` do not, so the phase stays
your `next`.

Two ways to un-record, and the difference matters:

- **`clear`** unrecords one phase and nothing else. This is the everyday correction
  of a mis-tick, and it is what the pane's `space` does on a settled phase.
- **`reset`** unrecords that phase *and every later one*, and counts a new round —
  for when work genuinely goes back: new code needs new checks, new review, new
  testing. It has no key in the pane on purpose; use `wipline reset <phase>`.

Nothing is ever deleted. `wipline history` shows every round, so a task that went
round the pipeline three times still tells you what happened the first time.

## Usage

```bash
wipline done checks              # the task comes from the current branch name
wipline wip dev                  # mark what you are on
wipline skip qa --detail "reason=docs-only"
wipline clear checks             # un-tick just this one
wipline reset dev                # back to dev, everything after it reopens
wipline get                      # KEY=value, for scripts
wipline board                    # every task in flight
wipline history ACME-42          # the whole journal, by round
wipline-tui                      # the interactive pane
wipline-pane toggle              # ...inside a herdr split
```

The task key is read from the branch name, so `feature/ACME-42-thing` resolves to
`ACME-42`. Pass a key explicitly to work on another task from anywhere.

### The pane

`wipline-tui` runs in any terminal. `wipline-pane` is a thin launcher for
[herdr](https://github.com/persiyanov/herdr) that splits a narrow column beside the
pane you are focused on and resolves the task from that pane's directory, falling
back to its tab title — so the pane opens on the task you are actually working on,
and shows the board as a picker only when it cannot tell.

Bind it to a key (herdr's `config.toml`):

```toml
[[keys.command]]
key = "f2"
type = "shell"
command = "wipline-pane toggle"
description = "phase board"
```

One instance per tab, so several tasks can have their own pane open at once.

## Config

`.wipline.json` in your repository, searched upward from the working directory. A
user-level `~/.config/wipline/config.json` supplies defaults; the project file wins.

```json
{
  "taskPattern": "[A-Z][A-Z0-9]*-\\d+",
  "stateDir": "~/.local/state/wipline",
  "phases": [
    { "name": "spec",    "stage": "planning" },
    { "name": "build",   "stage": "build" },
    { "name": "checks",  "stage": "build" },
    { "name": "review",  "stage": "review" },
    { "name": "ship",    "stage": "handover" }
  ]
}
```

- **`taskPattern`** — a regexp matching your task keys. Jira-style by default; use
  `#\\d+` for GitHub issues.
- **`stateDir`** — where journals live. Deliberately outside the repository: this is
  your state, not the project's, and it should not turn into merge conflicts.
- **`phases`** — the pipeline, in order. Order matters: `reset` cascades along it,
  and `next` is the first phase that has not passed.
- **`stage`** — a display caption used to group the list. **Phases sharing a stage
  must be adjacent**; the pane opens a new group whenever the stage changes, so a
  stage appearing twice would draw twice. Config loading rejects it rather than
  rendering something confusing.

## Wiring the automation

**This is the part that matters.** A hand-ticked checklist rots exactly when you are
busy — which is when you needed it. Every phase that leaves a trace should record
itself, and then the pane is a display rather than a chore.

The contract is one line: **anything that can run a command can record a phase.**

```bash
wipline done <phase> --by <who> [--detail "k=v"]
```

It is idempotent — an identical repeat appends nothing — so you can call it eagerly
from a watcher or a hook without filling `history` with noise.

### One rule to follow

**A step that fails its own check must not record its phase.** An unrecorded phase
is a small annoyance; a phase that claims success falsely is worse than having no
tracking at all. So guard every call on the thing having actually worked:

```bash
npm run lint && wipline done lint --by ci
```

### Claude Code

Two mechanisms, and the choice depends on whether you own the thing doing the work.

**1. Skills and commands you own — one line at the end.**

At the end of a skill's procedure, after its own verification passes:

````markdown
Record the phase:

```bash
wipline done tests-review --by reviewing-tests
```

Only on the green path — a red gate means the review did not conclude. Exit 3 means
the branch carries no task key: ignore it, and keep it out of the report.
````

**2. Skills you do NOT own — a hook on the artifact.**

Built-in skills, and skills from a plugin cache that an update would overwrite,
cannot be edited. Hook the *artifact* instead: the file they write, or the tool they
call. In `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "sh .claude/hooks/wipline-phase.sh", "timeout": 10 }]
      }
    ]
  }
}
```

And the hook, which must **fail open** — it runs in every session, including ones
that have nothing to do with a task:

```sh
#!/bin/sh
set -u
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
command -v wipline >/dev/null 2>&1 || exit 0

repo=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$repo" ] || exit 0
cd "$repo" 2>/dev/null || exit 0

file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
case "$file" in
  */specs/*) phase=spec ;;
  */plans/*) phase=plan ;;
  *) exit 0 ;;
esac

wipline done "$phase" --by hook --detail "path=$file" >/dev/null 2>&1
exit 0
```

Two things that are easy to get wrong here, both learned the hard way:

- **`cd` into the session's `cwd` first.** wipline reads the task key from the
  current branch, and a hook does not necessarily start in the directory the session
  is working in — especially with git worktrees, where a shared config directory can
  be a symlink into a completely different checkout. Get this wrong and phases are
  recorded against another task.
- **Exit 0 on every path.** A hook that fails breaks unrelated work, which is far
  worse than a missing tick.

**3. A tool call as the signal.** When a skill reports through a tool, hook that
tool's name instead of a file path, and read the payload to decide between `done` and
`open`. For a review tool that reports findings:

```sh
total=$(printf '%s' "$input" | jq -r '(.tool_input.findings // []) | length')
if [ "$total" -eq 0 ]; then
  wipline done review --by review-tool >/dev/null 2>&1
else
  wipline open review --by review-tool --detail "n=$total" >/dev/null 2>&1
fi
```

That is what `open` is for: the step ran, and there is something left to do.

### git, CI and watchers

Nothing about wipline is Claude-specific. Anything that already knows a step
finished can say so.

**A green suite, stamped with the commit it was green at:**

```bash
npm test && wipline done checks --by ci --detail "head=$(git rev-parse --short HEAD)"
```

The `head=` stamp buys something worth understanding: **a phase recorded with a head
is reported `open reason=stale` as soon as the branch moves on.** "The suite passed"
is a fact about a commit, not about a branch, so once you commit again the phase
un-passes itself and shows up as your `next` again. This works for any phase, not
just tests — stamp anything whose truth expires when the code changes.

**A merge request opened:**

```bash
iid=$(gh pr view --json number --jq .number) && wipline done mr --by gh --detail "iid=$iid"
```

**A post-commit hook marking development underway:**

```sh
# .git/hooks/post-commit
wipline wip dev --by git >/dev/null 2>&1 || true
```

### What cannot be automated

Some steps leave no trace: you tested it by hand, you read the diff yourself. Those
stay manual, and that is why `wip` exists — mark what you are on, and let whichever
automation finishes the step clear the marker by recording it. Nothing has to unset a
`wip`: any later record for the same phase replaces it.

## The journal

One tab-separated append-only file per task, in `stateDir`:

```
2026-08-19T09:14:02Z	start	done	starting-a-task
2026-08-19T10:02:41Z	spec	done	hook	path=docs/spec.md
2026-08-19T13:20:10Z	checks	done	ci	head=c7a57c0 ran=lint,types
2026-08-19T14:05:33Z	review	open	review-tool	n=3
2026-08-20T09:00:00Z	dev	reset	me	reason=qa-feedback
```

Five fields: timestamp, phase, state, who, and free-form `k=v` detail. Appending a
short line is atomic, so several sessions and hooks can write at once without a lock
and without losing records — which is the reason it is a log and not a JSON document.

Reading it is the reverse: fold the records, last write per phase wins, `reset`
clears its phase and everything after it. All of that lives in one tested module, so
every surface agrees.

## Development

```bash
node --test test/*.test.mjs
```

No dependencies, no build. `lib/phases.mjs` is pure — the fold and the vocabulary,
no I/O. `lib/store.mjs` owns the files. `lib/view.mjs` is pure rendering, so the
layout is tested without a terminal.

## License

MIT
