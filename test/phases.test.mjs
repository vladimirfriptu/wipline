import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, phaseNames, stageMap, stageOf,
  parseJournal, parseDetail, fold, formatLine, isDuplicate,
} from '../lib/phases.mjs';

const CONFIG = {
  taskPattern: '[A-Z][A-Z0-9]*-\\d+',
  stateDir: '/tmp/unused',
  phases: [
    { name: 'plan', stage: 'planning' },
    { name: 'build', stage: 'build' },
    { name: 'checks', stage: 'build' },
    { name: 'review', stage: 'review' },
    { name: 'ship', stage: 'handover' },
  ],
};
const PHASES = phaseNames(CONFIG);

function journal(...lines) {
  return parseJournal(lines.map((fields) => fields.join('\t')).join('\n'), PHASES);
}

test('phaseNames and stageMap come from config, not from code', () => {
  assert.deepEqual(PHASES, ['plan', 'build', 'checks', 'review', 'ship']);
  assert.deepEqual(stageMap(CONFIG).checks, 'build');
  assert.equal(stageOf(CONFIG, 'ship'), 'handover');
  assert.equal(stageOf(CONFIG, 'nope'), '');
});

test('the six states are the whole vocabulary', () => {
  assert.deepEqual(STATES, ['done', 'open', 'skip', 'reset', 'clear', 'wip']);
});

test('parseDetail turns k=v pairs into an object', () => {
  assert.deepEqual(parseDetail('head=abc1234 ran=lint,types'), { head: 'abc1234', ran: 'lint,types' });
  assert.deepEqual(parseDetail(''), {});
});

test('parseJournal ignores blank, short, unknown-phase and unknown-state lines', () => {
  const records = parseJournal([
    '',
    'garbage',
    '2026-08-19T09:00:00Z\tnot-a-phase\tdone\tx\t',
    '2026-08-19T09:00:00Z\tplan\tnot-a-state\tx\t',
    '2026-08-19T09:00:00Z\tplan\tdone\tme\tnote=1',
  ].join('\n'), PHASES);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    ts: '2026-08-19T09:00:00Z', phase: 'plan', state: 'done', by: 'me', detail: 'note=1',
  });
});

test('fold keeps the last record per phase and reports the first unpassed as next', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'plan', 'wip', 'me', ''],
    ['2026-08-19T09:01:00Z', 'plan', 'done', 'me', ''],
    ['2026-08-19T09:02:00Z', 'build', 'skip', 'me', 'reason=nothing-to-build'],
  ), PHASES);

  assert.equal(folded.phases.plan.state, 'done');
  assert.equal(folded.doneCount, 2);
  assert.equal(folded.next, 'checks');
});

test('an empty journal is all-pending, round one', () => {
  const folded = fold([], PHASES);

  assert.equal(folded.next, 'plan');
  assert.equal(folded.doneCount, 0);
  assert.equal(folded.round, 1);
});

test('next is null once every phase has passed', () => {
  const folded = fold(journal(...PHASES.map((name, i) => [
    `2026-08-19T09:0${i}:00Z`, name, 'done', 'me', '',
  ])), PHASES);

  assert.equal(folded.next, null);
  assert.equal(folded.doneCount, PHASES.length);
});

test('wip does not count as passed and becomes next', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'plan', 'done', 'me', ''],
    ['2026-08-19T09:01:00Z', 'build', 'wip', 'me', ''],
  ), PHASES);

  assert.equal(folded.phases.build.state, 'wip');
  assert.equal(folded.doneCount, 1);
  assert.equal(folded.next, 'build');
});

test('any later record for the same phase replaces wip', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'build', 'wip', 'me', ''],
    ['2026-08-19T09:05:00Z', 'build', 'done', 'ci', ''],
  ), PHASES);

  assert.equal(folded.phases.build.state, 'done');
});

test('wip survives work landing on a different phase', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'build', 'wip', 'me', ''],
    ['2026-08-19T09:05:00Z', 'review', 'done', 'ci', ''],
  ), PHASES);

  assert.equal(folded.phases.build.state, 'wip');
});

test('clear unrecords one phase, leaves the rest, and does not bump the round', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'plan', 'done', 'me', ''],
    ['2026-08-19T09:01:00Z', 'build', 'done', 'me', ''],
    ['2026-08-19T09:02:00Z', 'plan', 'clear', 'me', ''],
  ), PHASES);

  assert.equal(folded.phases.plan, undefined);
  assert.equal(folded.phases.build.state, 'done');
  assert.equal(folded.round, 1);
  assert.equal(folded.next, 'plan');
});

test('reset unrecords its phase and every later one, and counts a new round', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'plan', 'done', 'me', ''],
    ['2026-08-19T09:01:00Z', 'build', 'done', 'me', ''],
    ['2026-08-19T09:02:00Z', 'review', 'done', 'me', ''],
    ['2026-08-19T09:03:00Z', 'build', 'reset', 'me', 'reason=qa-feedback'],
  ), PHASES);

  assert.equal(folded.phases.plan.state, 'done');
  assert.equal(folded.phases.build, undefined);
  assert.equal(folded.phases.review, undefined);
  assert.equal(folded.round, 2);
});

test('a skip from the previous round comes back pending after a reset', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'build', 'done', 'me', ''],
    ['2026-08-19T09:01:00Z', 'review', 'skip', 'me', 'reason=trivial'],
    ['2026-08-19T09:02:00Z', 'build', 'reset', 'me', ''],
  ), PHASES);

  assert.equal(folded.phases.review, undefined);
});

test('a head-stamped phase reads open once the branch moves on', () => {
  const records = journal(
    ['2026-08-19T09:00:00Z', 'plan', 'done', 'me', ''],
    ['2026-08-19T09:01:00Z', 'build', 'done', 'me', ''],
    ['2026-08-19T09:02:00Z', 'checks', 'done', 'ci', 'head=abc1234 ran=lint'],
  );

  const current = fold(records, PHASES, { head: 'abc1234' });
  const moved = fold(records, PHASES, { head: 'def5678' });

  assert.equal(current.phases.checks.state, 'done');
  assert.equal(moved.phases.checks.state, 'open');
    assert.match(moved.phases.checks.detail, /reason=stale/);
  assert.equal(moved.next, 'checks');
});

test('staleness applies to any phase, not to one named checks', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'review', 'done', 'ci', 'head=abc1234'],
  ), PHASES, { head: 'def5678' });

  assert.equal(folded.phases.review.state, 'open');
});

test('a phase with no head stamp is never called stale', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'checks', 'done', 'ci', ''],
  ), PHASES, { head: 'def5678' });

  assert.equal(folded.phases.checks.state, 'done');
});

test('isDuplicate suppresses identical repeats and pointless clears', () => {
  const folded = fold(journal(
    ['2026-08-19T09:00:00Z', 'plan', 'done', 'ci', 'note=1'],
  ), PHASES);

  assert.equal(isDuplicate(folded, 'plan', 'done', 'note=1'), true);
  assert.equal(isDuplicate(folded, 'plan', 'done', 'note=2'), false);
  assert.equal(isDuplicate(folded, 'plan', 'wip', 'note=1'), false);
  // Nothing to clear on a phase that carries no record.
  assert.equal(isDuplicate(folded, 'build', 'clear', ''), true);
  assert.equal(isDuplicate(folded, 'plan', 'clear', ''), false);
});

test('formatLine reports task, next and progress, marking rounds above one', () => {
  const one = fold(journal(['2026-08-19T09:00:00Z', 'plan', 'done', 'me', '']), PHASES);
  const two = fold(journal(
    ['2026-08-19T09:00:00Z', 'plan', 'done', 'me', ''],
    ['2026-08-19T09:01:00Z', 'plan', 'reset', 'me', ''],
  ), PHASES);

  assert.equal(formatLine(one, 'ACME-1', PHASES.length), 'ACME-1 build 1/5');
  assert.equal(formatLine(two, 'ACME-1', PHASES.length), 'ACME-1 plan 0/5 ↻2');
});
