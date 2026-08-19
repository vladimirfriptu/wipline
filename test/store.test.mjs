import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';

function freshStore() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipline-store-'));
  const config = {
    taskPattern: '[A-Z][A-Z0-9]*-\\d+',
    stateDir,
    phases: [
      { name: 'plan', stage: 'planning' },
      { name: 'build', stage: 'build' },
      { name: 'review', stage: 'review' },
      { name: 'ship', stage: 'handover' },
    ],
  };
  return { store: createStore({ config }), stateDir };
}

test('readState returns every phase in order, pending, for an untouched task', () => {
  const { store } = freshStore();

  const state = store.readState('ACME-1');

  assert.equal(state.task, 'ACME-1');
  assert.equal(state.round, 1);
  assert.equal(state.next, 'plan');
  assert.deepEqual(state.phases.map((row) => row.phase), ['plan', 'build', 'review', 'ship']);
  for (const row of state.phases) {
    assert.equal(row.state, '');
    assert.ok(row.stage.length > 0);
  }
});

test('record appends and readState reflects it', () => {
  const { store } = freshStore();

  const after = store.record('ACME-1', 'plan', 'done', 'note=1', 'ci');
  const plan = after.phases.find((row) => row.phase === 'plan');

  assert.equal(plan.state, 'done');
  assert.equal(plan.by, 'ci');
  assert.equal(plan.detail, 'note=1');
  assert.equal(after.next, 'build');
});

test('record is idempotent for an identical repeat', () => {
  const { store, stateDir } = freshStore();

  store.record('ACME-1', 'plan', 'done');
  store.record('ACME-1', 'plan', 'done');
  store.record('ACME-1', 'plan', 'done');

  const log = fs.readFileSync(path.join(stateDir, 'ACME-1.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 1);
});

test('the journal is append-only, so history keeps every round', () => {
  const { store } = freshStore();

  store.record('ACME-1', 'plan', 'done');
  store.record('ACME-1', 'build', 'done');
  store.record('ACME-1', 'build', 'reset', 'reason=rework');
  store.record('ACME-1', 'build', 'wip');

  const records = store.history('ACME-1');

  assert.deepEqual(records.map((r) => `${r.phase}:${r.state}`),
    ['plan:done', 'build:done', 'build:reset', 'build:wip']);
  assert.equal(store.readState('ACME-1').round, 2);
});

test('an unknown phase or action is refused with a typed error', () => {
  const { store } = freshStore();

  assert.throws(() => store.record('ACME-1', 'nope', 'done'), (e) => e.code === 'UNKNOWN_PHASE');
  assert.throws(() => store.record('ACME-1', 'plan', 'nope'), (e) => e.code === 'INVALID_ACTION');
  assert.throws(() => store.record('lowercase-1', 'plan', 'done'), (e) => e.code === 'NO_TASK');
});

test('listTasks reports tasks in flight and hides ones whose last phase is done', () => {
  const { store } = freshStore();

  store.record('ACME-1', 'plan', 'done');
  store.record('ACME-2', 'build', 'wip');
  store.record('ACME-2', 'review', 'open', 'n=3');
  for (const phase of ['plan', 'build', 'review', 'ship']) store.record('ACME-3', phase, 'done');

  const tasks = store.listTasks();

  assert.deepEqual(tasks.map((t) => t.task), ['ACME-1', 'ACME-2']);
  const second = tasks.find((t) => t.task === 'ACME-2');
  assert.deepEqual(second.wip, ['build']);
  assert.deepEqual(second.open, ['review']);
  assert.equal(second.total, 4);
});

test('listTasks ignores files that are not task journals', () => {
  const { store, stateDir } = freshStore();

  store.record('ACME-1', 'plan', 'done');
  fs.writeFileSync(path.join(stateDir, 'notes.log'), 'nonsense\n');
  fs.writeFileSync(path.join(stateDir, 'pane.w1_t1'), 'w1:p2\n');

  assert.deepEqual(store.listTasks().map((t) => t.task), ['ACME-1']);
});

test('listTasks is empty when nothing has been tracked', () => {
  const { store } = freshStore();

  assert.deepEqual(store.listTasks(), []);
});

test('reading a task never blocks on resolving its branch', () => {
  const { store } = freshStore();
  store.record('ACME-1', 'plan', 'done');

  const startedAt = Date.now();
  const state = store.readState('ACME-1');

  assert.equal(typeof state.branch, 'string');
  assert.ok(Date.now() - startedAt < 200, 'the read path must not wait for git');
});
