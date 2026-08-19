#!/usr/bin/env node
// Interactive phase board for a terminal pane. Board first; enter drills into one
// task's phases. Talks to the store in-process — no server, no HTTP.
//
//   wipline-tui [TASK]
//
// With a task key, opens straight into that task's phases. Without one, opens the
// board and preselects the task of the current branch when there is one.
import { createStore, currentTask } from '../lib/store.mjs';
import { loadConfig, taskRegExp } from '../lib/config.mjs';
import { moveCursor, keyAction, renderBoard, renderPhases } from '../lib/view.mjs';

const config = loadConfig();
const store = createStore({ config });
const isTask = taskRegExp(config);

const REFRESH_MS = 2000;

const state = {
  screen: 'board',
  boardCursor: 0,
  phaseCursor: 0,
  task: null,
  summaries: [],
  phases: null,
  message: '',
  ready: false,
};

function loadBoard() {
  state.summaries = store.listTasks();
  if (state.boardCursor > state.summaries.length - 1) {
    state.boardCursor = Math.max(0, state.summaries.length - 1);
  }
}

function loadPhases() {
  if (!state.task) return;
  state.phases = store.readState(state.task);
  if (state.phaseCursor > state.phases.phases.length - 1) state.phaseCursor = 0;
}

function draw() {
  // `columns` inside a herdr pane reports the whole window, not the pane, so the
  // launcher passes the real column count. Fall back to the capped guess when the
  // TUI is run by hand outside a pane.
  const declared = Number.parseInt(process.env.WIPLINE_WIDTH ?? '', 10);
  // Two columns of margin, not one: the pane rect herdr reports includes the
  // split separator, so writing rect-width characters wraps the last one.
  const width = Number.isFinite(declared) && declared > 0
    ? Math.max(32, declared - 3)
    : Math.min(64, Math.max(32, (process.stdout.columns ?? 60) - 1));
  const lines = state.screen === 'board'
    ? renderBoard(state.summaries, state.boardCursor, width)
    : renderPhases(state.phases, state.phaseCursor, width);

  if (state.message) lines.push(`\x1b[2m ${state.message}\x1b[0m`);

  // Home + clear-to-end rather than a full clear: a full clear flickers on every
  // 2s refresh, which is unreadable in a narrow pane.
  process.stdout.write(`\x1b[H\x1b[J${lines.join('\n')}\n`);
}

function openTask(task) {
  state.task = task;
  state.screen = 'phases';
  state.phaseCursor = 0;
  state.message = '';
  loadPhases();
}

function openSelected() {
  const summary = state.summaries[state.boardCursor];
  if (!summary) return;
  openTask(summary.task);
}

function mutate(mutation) {
  const row = state.phases.phases[state.phaseCursor];
  if (!row) return;
  // A phase already in this state would append nothing anyway (isDuplicate), but
  // saying so beats a keypress that looks ignored.
  if (mutation === 'skip' && row.state === 'skip') {
    state.message = `${row.phase} is already skipped`;
    return;
  }
  try {
    state.phases = store.record(state.task, row.phase, mutation, '', 'tui');
    state.message = `${row.phase} → ${mutation === 'clear' ? 'not done' : mutation}`;
  } catch (err) {
    state.message = `failed: ${err.message}`;
  }
}

function handle(key) {
  // The newline that submitted the launch command arrives here as Enter and would
  // open whatever the cursor sits on. Drop anything buffered from before we drew.
  if (!state.ready) return;

  const row = state.screen === 'phases' ? state.phases?.phases[state.phaseCursor] : undefined;
  const action = keyAction(state.screen, key, row);
  if (!action) return;

  if (action.kind === 'quit') return exit();

  if (action.kind === 'up' || action.kind === 'down') {
    const delta = action.kind === 'up' ? -1 : 1;
    if (state.screen === 'board') {
      state.boardCursor = moveCursor(state.boardCursor, delta, state.summaries.length);
    } else {
      state.phaseCursor = moveCursor(state.phaseCursor, delta, state.phases.phases.length);
    }
    state.message = '';
  }

  if (action.kind === 'open') openSelected();

  if (action.kind === 'back') {
    state.screen = 'board';
    state.message = '';
    loadBoard();
  }

  if (action.kind === 'refresh') {
    if (state.screen === 'board') loadBoard(); else loadPhases();
    state.message = 'refreshed';
  }

  if (action.mutation) mutate(action.mutation);

  draw();
}

function exit() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\x1b[H\x1b[J');
  process.exit(0);
}

function main() {
  const requested = process.argv[2];
  loadBoard();

  // The board is the picker, shown only when the context does not name a task.
  // An argument wins; otherwise the branch of this pane's cwd answers it.
  const resolved = requested || currentTask(config);
  if (resolved) {
    const index = state.summaries.findIndex((s) => s.task === resolved);
    if (index >= 0) state.boardCursor = index;
    // Open it even with no journal yet — a task started a minute ago has none, and
    // dropping to the picker there would hide the very phases about to be ticked.
    if (isTask.test(resolved)) openTask(resolved);
  }

  if (!process.stdin.isTTY) {
    // Useful for a smoke check: render once and leave, rather than hanging on a
    // stdin that will never deliver a key.
    draw();
    process.exit(0);
  }

  process.stdout.write('\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handle);
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
  process.stdout.on('resize', draw);

  setInterval(() => {
    if (state.screen === 'board') loadBoard(); else loadPhases();
    draw();
  }, REFRESH_MS).unref?.();

  draw();
  setTimeout(() => { state.ready = true; }, 250);
}

main();
