// Pure rendering and key mapping for the phase TUI. No TTY, no I/O, no state —
// so the layout and the cascade preview can be tested without a terminal.

export const GLYPHS = {
  done: '✔',
  skip: '⊘',
  open: '◐',
  wip: '»',
  none: '○',
};

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// `wip` is deliberately absent: space on a phase in progress finishes it rather
// than unrecording it, which is the whole point of marking it in the first place.
const RECORDED = ['done', 'skip', 'open'];

export function moveCursor(cursor, delta, length) {
  if (length <= 0) return 0;
  const next = cursor + delta;
  if (next < 0) return 0;
  if (next > length - 1) return length - 1;
  return next;
}

export function isRecorded(row) {
  return RECORDED.includes(row?.state);
}

// `open` counts as recorded: it ran, so space unrecords it rather than closing it
// as if it had finished cleanly.
export function keyAction(screen, key, row) {
  if (key === '\x1b[A' || key === 'k') return { kind: 'up' };
  if (key === '\x1b[B' || key === 'j') return { kind: 'down' };
  if (key === 'q' || key === '\x03') return { kind: 'quit' };
  if (key === 'r') return { kind: 'refresh' };

  if (screen === 'board') {
    if (key === '\r' || key === '\n') return { kind: 'open' };
    return null;
  }

  // Space always moves toward done — from nothing and from `wip` alike — and only
  // unrecords a phase that is already settled. It affects one phase: unticking used
  // to cascade, which turned a mis-tick into a dozen re-ticks.
  if (key === ' ') {
    return { kind: 'toggle', mutation: isRecorded(row) ? 'clear' : 'done' };
  }
  if (key === 's') return { kind: 'skip', mutation: 'skip' };
  // Set by hand only; whatever automation later closes the phase replaces it.
  if (key === 'w') return { kind: 'wip', mutation: 'wip' };
  // No key for `reset`. The cascade stays in the fold module and the CLI
  // (`task-phase.mjs reset`), but it is not reachable from this pane: correcting a
  // tick should never reopen ten phases. Restore a key here if that changes.
  if (key === '\x1b') return { kind: 'back' };
  return null;
}

// What a reset of `phase` would clear: itself and every later phase, in the order
// the payload already carries. Currently unused — the pane has no reset key — and
// kept because the cascade may come back as a confirmed action.
export function cascadeFrom(rows, phase) {
  const from = rows.findIndex((row) => row.phase === phase);
  if (from < 0) return [];
  return rows.slice(from).map((row) => row.phase);
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(text) {
  return text.replace(ANSI, '').length;
}

// Truncation has to count visible characters, not bytes: a row carrying a dim note
// is mostly escape sequences, and slicing on raw length both cuts far too early
// and can land inside an escape — which paints the rest of the pane the wrong
// colour or emits a broken glyph.
function fit(text, width) {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return '';

  let visible = 0;
  let out = '';
  let index = 0;
  while (index < text.length && visible < width - 1) {
    ANSI.lastIndex = index;
    const match = ANSI.exec(text);
    if (match && match.index === index) {
      out += match[0];
      index = ANSI.lastIndex;
      continue;
    }
    out += text[index];
    visible += 1;
    index += 1;
  }
  return `${out}…\x1b[0m`;
}

function rule(width) {
  return `${DIM}${'─'.repeat(Math.max(0, width))}${RESET}`;
}

export function renderBoard(summaries, cursor, width) {
  const lines = [`${BOLD}${fit('TASKS IN FLIGHT', width)}${RESET}`, rule(width)];

  if (summaries.length === 0) {
    lines.push(fit('  nothing tracked yet — tracking starts at /task', width));
    lines.push(rule(width));
    lines.push(`${DIM}${fit(' q quit', width)}${RESET}`);
    return lines;
  }

  summaries.forEach((summary, index) => {
    const marker = index === cursor ? '▸' : ' ';
    // A wip phase is what is actually being worked on; `next` alone cannot tell
    // "in progress" from "not started".
    const wip = summary.wip?.[0];
    const next = wip ? `${GLYPHS.wip} ${wip}` : (summary.next ?? 'done');
    const round = summary.round > 1 ? `  ↻${summary.round}` : '';
    const body = `${marker} ${summary.task}  ${next.padEnd(12)} ${String(summary.doneCount).padStart(2)}/${summary.total}${round}`;
    lines.push(index === cursor ? `${BOLD}${fit(body, width)}${RESET}` : fit(body, width));
  });

  lines.push(rule(width));
  lines.push(`${DIM}${fit(' ↑↓ move   enter open   r refresh   q quit', width)}${RESET}`);
  return lines;
}

export function renderPhases(state, cursor, width) {
  const round = state.round > 1 ? `  ↻${state.round}` : '';
  const lines = [
    `${BOLD}${fit(`${state.task}${round}`, width)}${RESET}`,
    rule(width),
  ];


  let previousStage = '';
  state.phases.forEach((row, index) => {
    if (row.stage !== previousStage) {
      lines.push(`${DIM}${fit(`  ${row.stage.toUpperCase()}`, width)}${RESET}`);
      previousStage = row.stage;
    }

    const marker = index === cursor ? '▸' : ' ';
    const glyph = GLYPHS[row.state] ?? GLYPHS.none;
    const chip = row.action?.kind === 'qa' ? ' [qa]'
      : row.action?.kind === 'link' ? ` [${row.action.label}]`
      : '';
    const note = noteFor(row);
    const body = `${marker} ${glyph} ${row.phase.padEnd(13)}${chip}${note}`.trimEnd();

    if (index === cursor) lines.push(`${BOLD}${fit(body, width)}${RESET}`);
    else lines.push(fit(body, width));
  });

  lines.push(rule(width));
  const next = state.next ?? 'done';
  const passed = state.phases.filter((row) => row.state === 'done' || row.state === 'skip').length;
  lines.push(fit(` next: ${next}   ${passed}/${state.phases.length}`, width));
  lines.push(`${DIM}${fit(' ↑↓  space done  w wip  s skip  esc back  q quit', width)}${RESET}`);
  return lines;
}

function noteFor(row) {
  if (row.state === 'wip') return `${DIM}  in progress${RESET}`;
  if (row.state === 'open' && /reason=stale/.test(row.detail)) return `${DIM}  stale${RESET}`;
  if (row.state === 'open') {
    const n = row.detail.match(/\bn=(\d+)/);
    return n ? `${DIM}  ${n[1]} open${RESET}` : `${DIM}  open${RESET}`;
  }
  if (row.state === 'skip') return `${DIM}  skipped${RESET}`;
  if (row.state === 'done' && row.by) return `${DIM}  ${row.by}${RESET}`;
  return '';
}
