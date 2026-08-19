import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveCursor,
  keyAction,
  cascadeFrom,
  renderBoard,
  renderPhases,
  GLYPHS,
  visibleLength,
} from '../lib/view.mjs';

const SUMMARIES = [
  { task: 'ACME-101', next: 'checks', round: 1, doneCount: 5, total: 14, open: [] },
  { task: 'ACME-102', next: 'review', round: 2, doneCount: 3, total: 14, open: ['review'] },
  { task: 'ACME-103', next: null, round: 1, doneCount: 14, total: 14, open: [] },
];

function phaseState(overrides = {}) {
  const phases = [
    { phase: 'start', state: 'done', by: 'task-start', detail: '', stage: 'planning' },
    { phase: 'spec', state: 'done', by: 'Write', detail: '', stage: 'planning' },
    { phase: 'plan', state: '', by: '', detail: '', stage: 'planning' },
    { phase: 'dev', state: 'skip', by: 'user', detail: 'reason=css', stage: 'build' },
    { phase: 'checks', state: 'open', by: 'checks.sh', detail: 'reason=stale', stage: 'build' },
    { phase: 'review', state: '', by: '', detail: '', stage: 'review' },
  ];
  return { task: 'ACME-101', branch: 'feature/ACME-101-x', round: 1, next: 'plan', phases, ...overrides };
}

test('moveCursor clamps at both ends instead of wrapping', () => {
  assert.equal(moveCursor(0, -1, 3), 0);
  assert.equal(moveCursor(0, 1, 3), 1);
  assert.equal(moveCursor(2, 1, 3), 2);
  assert.equal(moveCursor(1, -1, 3), 0);
});

test('moveCursor survives an empty list', () => {
  assert.equal(moveCursor(0, 1, 0), 0);
  assert.equal(moveCursor(0, -1, 0), 0);
});

test('keyAction maps the board keys', () => {
  assert.equal(keyAction('board', '\x1b[A').kind, 'up');
  assert.equal(keyAction('board', '\x1b[B').kind, 'down');
  assert.equal(keyAction('board', 'k').kind, 'up');
  assert.equal(keyAction('board', 'j').kind, 'down');
  assert.equal(keyAction('board', '\r').kind, 'open');
  assert.equal(keyAction('board', 'q').kind, 'quit');
  assert.equal(keyAction('board', 'r').kind, 'refresh');
  assert.equal(keyAction('board', 'x'), null);
});

test('keyAction maps the phase-screen keys, including esc back', () => {
  assert.equal(keyAction('phases', ' ').kind, 'toggle');
  assert.equal(keyAction('phases', 's').kind, 'skip');
  assert.equal(keyAction('phases', '\x1b').kind, 'back');
  assert.equal(keyAction('phases', 'q').kind, 'quit');
  assert.equal(keyAction('phases', '\x1b[A').kind, 'up');
});

test('esc is back on the phase screen but not an arrow prefix', () => {
  // A bare ESC and an arrow sequence both start with \x1b; the arrow is matched
  // first, so a lone ESC must still mean "back".
  assert.equal(keyAction('phases', '\x1b[B').kind, 'down');
  assert.equal(keyAction('phases', '\x1b').kind, 'back');
});

test('space ticks an unrecorded phase and clears a recorded one, never cascading', () => {
  const state = phaseState();
  const plan = state.phases.findIndex((p) => p.phase === 'plan');
  const start = state.phases.findIndex((p) => p.phase === 'start');
  const checks = state.phases.findIndex((p) => p.phase === 'checks');

  assert.equal(keyAction('phases', ' ', state.phases[plan]).mutation, 'done');
  assert.equal(keyAction('phases', ' ', state.phases[start]).mutation, 'clear');
  // `open` counts as recorded, so space unrecords it — one phase, not the tail.
  assert.equal(keyAction('phases', ' ', state.phases[checks]).mutation, 'clear');
});

test('there is no reset key in the pane', () => {
  // The cascade stays in the fold module and the CLI; the pane must not offer it.
  assert.equal(keyAction('phases', 'R', phaseState().phases[0]), null);
});

test('cascadeFrom lists the phase and everything after it', () => {
  const state = phaseState();

  assert.deepEqual(cascadeFrom(state.phases, 'dev'), ['dev', 'checks', 'review']);
  assert.deepEqual(cascadeFrom(state.phases, 'review'), ['review']);
  assert.deepEqual(cascadeFrom(state.phases, 'nope'), []);
});

test('renderBoard marks the cursor and shows round only above one', () => {
  const lines = renderBoard(SUMMARIES, 1, 60).join('\n');

  assert.match(lines, /ACME-102/);
  assert.match(lines, /↻2/);
  assert.equal(/ACME-101.*↻/.test(lines), false);
  const cursorLine = renderBoard(SUMMARIES, 1, 60).find((l) => l.includes('ACME-102'));
  assert.match(cursorLine, /▸/);
});

test('renderBoard shows a finished pipeline as done rather than a blank next', () => {
  const lines = renderBoard(SUMMARIES, 0, 60).find((l) => l.includes('ACME-103'));

  assert.match(lines, /done/);
  assert.match(lines, /14\/14/);
});

test('renderBoard says so when nothing is tracked', () => {
  const lines = renderBoard([], 0, 60).join('\n');

  assert.match(lines, /nothing tracked|no tasks/i);
});

test('renderPhases groups by stage with one caption per group', () => {
  const lines = renderPhases(phaseState(), 0, 60);
  const captions = lines.filter((l) => /PLANNING|BUILD|REVIEW/.test(l));

  assert.equal(captions.length, 3);
});

test('renderPhases uses a distinct glyph per state', () => {
  const lines = renderPhases(phaseState(), 0, 60).join('\n');

  assert.ok(lines.includes(GLYPHS.done));
  assert.ok(lines.includes(GLYPHS.skip));
  assert.ok(lines.includes(GLYPHS.open));
  assert.ok(lines.includes(GLYPHS.none));
});

test('renderPhases never advertises a cascade', () => {
  const state = phaseState();
  const devIndex = state.phases.findIndex((p) => p.phase === 'dev');

  const lines = renderPhases(state, devIndex, 60).join('\n');

  assert.equal(/reopens|cascade|reset/i.test(lines), false);
});

test('renderPhases shows the stale reason and the qa chip', () => {
  const state = phaseState();
  state.phases.find((p) => p.phase === 'qa') ?? state.phases.push(
    { phase: 'qa-manual', state: '', by: '', detail: '', stage: 'testing', action: { kind: 'qa' } },
  );

  const lines = renderPhases(state, 0, 60).join('\n');

  assert.match(lines, /stale/);
  assert.match(lines, /qa/);
});

test('renderPhases renders a link action label', () => {
  const state = phaseState();
  state.phases.push({
    phase: 'mr', state: 'done', by: 'ship-runner', detail: 'iid=412',
    stage: 'handover', action: { kind: 'link', label: '!412', url: 'https://x/-/merge_requests/412' },
  });

  const lines = renderPhases(state, 0, 60).join('\n');

  assert.match(lines, /!412/);
});

test('renderPhases marks the round when the task has been round twice', () => {
  const lines = renderPhases(phaseState({ round: 3 }), 0, 60).join('\n');

  assert.match(lines, /↻3/);
});

test('every rendered line fits the given width', () => {
  const width = 44;
  const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');

  for (const line of renderBoard(SUMMARIES, 0, width)) {
    assert.ok(strip(line).length <= width, `board line too wide: ${strip(line).length}`);
  }
  for (const line of renderPhases(phaseState(), 0, width)) {
    assert.ok(strip(line).length <= width, `phase line too wide: ${strip(line).length}`);
  }
});

test('visibleLength ignores ANSI codes', () => {
  assert.equal(visibleLength('\x1b[2mabc\x1b[0m'), 3);
  assert.equal(visibleLength('abc'), 3);
});

test('a row with a dim note is not truncated while it visibly fits', () => {
  // Regression: fit() measured raw length, so the escape sequences in the note ate
  // the budget and the text was cut mid-word — and sometimes mid-escape.
  const state = {
    task: 'ACME-101', round: 1, next: 'review',
    phases: [{
      phase: 'dev', state: 'done', by: 'build-runner',
      detail: '', stage: 'build',
    }],
  };

  const line = renderPhases(state, 0, 53).find((l) => l.includes('dev'));

  assert.match(line, /build-runner/);
  assert.equal(line.includes('\u2026'), false);
});

test('truncation counts visible characters and closes the colour', () => {
  const state = {
    task: 'ACME-101', round: 1, next: 'review',
    phases: [{
      phase: 'handover-check', state: 'done',
      by: 'a-very-long-reporter-name-that-will-not-fit-in-here-at-all',
      detail: '', stage: 'handover',
    }],
  };

  const line = renderPhases(state, 0, 40).find((l) => l.includes('handover-check'));

  assert.ok(visibleLength(line) <= 40, `visible width was ${visibleLength(line)}`);
  assert.match(line, /\u2026/);
  assert.match(line, /\x1b\[0m$/);
});

test('space on a wip phase finishes it rather than unrecording it', () => {
  const wipRow = { phase: 'dev', state: 'wip', by: 'user', detail: '', stage: 'build' };

  assert.equal(keyAction('phases', ' ', wipRow).mutation, 'done');
});

test('w marks a phase in progress from any state', () => {
  const none = { phase: 'dev', state: '', by: '', detail: '', stage: 'build' };
  const done = { phase: 'dev', state: 'done', by: 'x', detail: '', stage: 'build' };

  assert.equal(keyAction('phases', 'w', none).mutation, 'wip');
  assert.equal(keyAction('phases', 'w', done).mutation, 'wip');
});

test('renderPhases shows the wip glyph and its note', () => {
  const state = {
    task: 'ACME-101', round: 1, next: 'dev',
    phases: [{ phase: 'dev', state: 'wip', by: 'user', detail: '', stage: 'build' }],
  };

  const line = renderPhases(state, 0, 56).find((l) => l.includes('dev'));

  assert.ok(line.includes(GLYPHS.wip));
  assert.match(line, /in progress/);
});

test('renderBoard shows the wip phase instead of the pending next', () => {
  const withWip = [{ task: 'ACME-101', next: 'dev', round: 1, doneCount: 3, total: 14, open: [], wip: ['dev'] }];
  const without = [{ task: 'ACME-101', next: 'dev', round: 1, doneCount: 3, total: 14, open: [], wip: [] }];

  const wipLine = renderBoard(withWip, 0, 56).find((l) => l.includes('ACME-101'));
  const plainLine = renderBoard(without, 0, 56).find((l) => l.includes('ACME-101'));

  assert.ok(wipLine.includes(GLYPHS.wip));
  assert.equal(plainLine.includes(GLYPHS.wip), false);
});

test('renderBoard tolerates a summary with no wip field', () => {
  // listTasks always sends one, but a stale client or a hand-built summary must not
  // crash the pane.
  const legacy = [{ task: 'ACME-101', next: 'dev', round: 1, doneCount: 3, total: 14, open: [] }];

  assert.doesNotThrow(() => renderBoard(legacy, 0, 56));
});

test('both footers fit the narrow pane width without truncation', () => {
  // The pane is 56 columns and the TUI renders to 53, so a hint one character too
  // long loses its last key to an ellipsis — which is how it reads as missing.
  const narrow = 53;
  const boardFoot = renderBoard(SUMMARIES, 0, narrow).at(-1);
  const phaseFoot = renderPhases(phaseState(), 0, narrow).at(-1);

  for (const foot of [boardFoot, phaseFoot]) {
    assert.equal(foot.includes('…'), false, `hint truncated: ${foot}`);
    assert.ok(visibleLength(foot) <= narrow);
  }
});
