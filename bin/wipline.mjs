#!/usr/bin/env node
// wipline — record and read which phase of your pipeline a task has reached.
//
//   wipline done <phase> [TASK]     mark it finished
//   wipline wip <phase> [TASK]      mark it in progress
//   wipline skip <phase> [TASK]     mark it not needed this round
//   wipline clear <phase> [TASK]    unrecord it, and nothing else
//   wipline reset <phase> [TASK]    unrecord it and every later phase
//   wipline get [TASK]              current state as KEY=value
//   wipline board                   every task in flight
//   wipline history [TASK]          the full journal, by round
//
// TASK defaults to the key found in the current branch name. Machine-read output is
// KEY=value with uppercase keys; `board` is formatted for a person.
//
// Exit codes: 0 fine, 2 usage, 3 no task could be resolved.
import { createStore, currentTask } from '../lib/store.mjs';
import { loadConfig } from '../lib/config.mjs';

const MUTATIONS = ['done', 'open', 'skip', 'wip', 'clear', 'reset'];

function die(message, code = 2) {
  process.stderr.write(`wipline: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = { by: 'user', detail: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--by' || arg === '--detail') {
      i += 1;
      if (i >= argv.length) die(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[i];
      continue;
    }
    if (arg.startsWith('-')) die(`unknown flag '${arg}'`);
    positional.push(arg);
  }
  return { positional, flags };
}

function phaseKey(phase) {
  return `PHASE_${phase.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  process.stdout.write(`usage: wipline ${MUTATIONS.join('|')} <phase> [TASK]\n`
    + '       wipline get|history [TASK]\n'
    + '       wipline board\n');
  process.exit(command ? 0 : 2);
}

const config = loadConfig();
const store = createStore({ config });

function resolve(explicit) {
  const task = explicit ?? currentTask(config);
  if (!task) die('no task given and the current branch carries no task key', 3);
  return task;
}

if (MUTATIONS.includes(command)) {
  const { positional, flags } = parseArgs(rest);
  const [phase, explicit] = positional;
  if (!phase) die(`${command} needs a phase name`);
  if (!store.phases.includes(phase)) {
    die(`unknown phase '${phase}' (one of: ${store.phases.join(', ')})`);
  }
  const task = resolve(explicit);
  try {
    const state = store.record(task, phase, command, flags.detail, flags.by);
    process.stdout.write(`${task} ${state.next ?? 'done'} `
      + `${state.phases.filter((p) => p.state === 'done' || p.state === 'skip').length}/${store.phases.length}\n`);
  } catch (err) {
    die(err.message, err.code === 'NO_TASK' ? 3 : 1);
  }
  process.exit(0);
}

if (command === 'get') {
  const { positional } = parseArgs(rest);
  const task = resolve(positional[0]);
  const state = store.readState(task);
  const passed = state.phases.filter((p) => p.state === 'done' || p.state === 'skip').length;
  const lines = [
    `TASK=${state.task}`,
    `BRANCH=${state.branch}`,
    `ROUND=${state.round}`,
    `NEXT=${state.next ?? ''}`,
    `DONE_COUNT=${passed}`,
    `TOTAL=${store.phases.length}`,
  ];
  for (const row of state.phases) lines.push(`${phaseKey(row.phase)}=${row.state}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

if (command === 'history') {
  const { positional } = parseArgs(rest);
  const task = resolve(positional[0]);
  const records = store.history(task);
  if (records.length === 0) {
    process.stdout.write(`${task}: nothing recorded yet\n`);
    process.exit(0);
  }
  const out = [`${task} — round 1`];
  let round = 1;
  for (const record of records) {
    if (record.state === 'reset') {
      round += 1;
      out.push(`  ${record.ts}  reset from ${record.phase}  ${record.detail}`.trimEnd());
      out.push(`${task} — round ${round}`);
      continue;
    }
    out.push(`  ${[record.ts, record.phase.padEnd(14), record.state.padEnd(5), record.by, record.detail].join('  ')}`.trimEnd());
  }
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

if (command === 'board') {
  const rows = store.listTasks().map((summary) => ({
    task: summary.task,
    next: summary.next ?? 'done',
    progress: `${summary.doneCount}/${summary.total}`,
    round: summary.round > 1 ? `↻${summary.round}` : '',
    wip: summary.wip.join(','),
    open: summary.open.join(','),
  }));

  if (rows.length === 0) {
    process.stdout.write('No tasks in flight.\n');
    process.exit(0);
  }

  const header = { task: 'TASK', next: 'NEXT', progress: 'DONE', round: '', wip: 'WIP', open: 'OPEN' };
  const columns = ['task', 'next', 'progress', 'round', 'wip', 'open'];
  const width = {};
  for (const column of columns) {
    width[column] = Math.max(...[header[column], ...rows.map((row) => row[column])].map((v) => v.length));
  }
  const render = (row) => columns.map((c) => row[c].padEnd(width[c])).join('  ').trimEnd();
  process.stdout.write(`${[render(header), ...rows.map(render)].join('\n')}\n`);
  process.exit(0);
}

die(`unknown command '${command}'`);
