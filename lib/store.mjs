import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { loadConfig, taskRegExp, findTaskIn } from './config.mjs';
import { phaseNames, stageMap, parseJournal, parseDetail, fold } from './phases.mjs';

const ACTIONS = new Set(['done', 'open', 'skip', 'wip', 'clear', 'reset']);

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function currentTask(config, cwd = process.cwd()) {
  return findTaskIn(git(['branch', '--show-current'], cwd), config);
}

export function createStore(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(cwd);
  const phases = phaseNames(config);
  const stages = stageMap(config);
  const isTask = taskRegExp(config);

  function assertTask(task) {
    if (!isTask.test(task ?? '')) {
      const err = new Error(`task must match ${config.taskPattern}, got "${task}"`);
      err.code = 'NO_TASK';
      throw err;
    }
  }

  function journalPath(task) {
    return path.join(config.stateDir, `${task}.log`);
  }

  function readJournal(task) {
    try {
      return fs.readFileSync(journalPath(task), 'utf8');
    } catch {
      return '';
    }
  }

  // Resolving a branch costs a full ref scan, and the pane re-reads every couple of
  // seconds, so the read path never waits for it: it returns what is cached and
  // refreshes in the background. The value appears on a later read.
  const targetCache = new Map();
  const inFlight = new Set();
  const TTL_MS = options.branchTtlMs ?? 300_000;

  function refreshTarget(task, now) {
    if (inFlight.has(task)) return;
    inFlight.add(task);
    execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      { cwd, encoding: 'utf8' }, (_err, stdout) => {
        const names = (stdout ?? '').split('\n')
          .map((raw) => (raw.startsWith('origin/') ? raw.slice('origin/'.length) : raw))
          .filter((name) => name.includes(task));
        const unique = [...new Set(names)];
        const branch = unique.length === 1 ? unique[0] : '';
        if (!branch) {
          targetCache.set(task, { branch: '', head: '', at: now });
          inFlight.delete(task);
          return;
        }
        // The head is the tip of the task's own branch, never `HEAD` here: this
        // process may run anywhere, including a worktree for a different task.
        execFile('git', ['rev-parse', '--short', branch], { cwd, encoding: 'utf8' },
          (_headErr, headOut) => {
            targetCache.set(task, { branch, head: (headOut ?? '').trim(), at: now });
            inFlight.delete(task);
          });
      });
  }

  function target(task, now) {
    const cached = targetCache.get(task);
    if (!cached || now - cached.at >= TTL_MS) refreshTarget(task, now);
    return { branch: cached?.branch ?? '', head: cached?.head ?? '' };
  }

  function rows(folded) {
    return phases.map((name) => {
      const record = folded.phases[name];
      const row = record
        ? { phase: name, state: record.state, by: record.by, ts: record.ts, detail: record.detail }
        : { phase: name, state: '', by: '', ts: '', detail: '' };
      row.stage = stages[name];
      return row;
    });
  }

  function readState(task) {
    assertTask(task);
    const resolved = target(task, Date.now());
    const folded = fold(parseJournal(readJournal(task), phases), phases, { head: resolved.head });
    return {
      task,
      branch: resolved.branch,
      round: folded.round,
      next: folded.next,
      phases: rows(folded),
    };
  }

  function record(task, phase, action, detail = '', by = 'user') {
    assertTask(task);
    if (!phases.includes(phase)) {
      const err = new Error(`unknown phase "${phase}"`);
      err.code = 'UNKNOWN_PHASE';
      throw err;
    }
    if (!ACTIONS.has(action)) {
      const err = new Error(`invalid action "${action}"`);
      err.code = 'INVALID_ACTION';
      throw err;
    }

    const folded = fold(parseJournal(readJournal(task), phases), phases);
    const current = folded.phases[phase];
    const duplicate = current
      ? current.state === action && current.detail === detail
      : action === 'clear';
    if (duplicate) return readState(task);

    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.appendFileSync(journalPath(task), `${[stamp, phase, action, by, detail].join('\t')}\n`);
    return readState(task);
  }

  // "In flight" is one rule and it lives here, so every surface agrees: a journal
  // exists and its last phase is not done.
  function listTasks() {
    let files;
    try {
      files = fs.readdirSync(config.stateDir).filter((name) => name.endsWith('.log'));
    } catch {
      return [];
    }
    const last = phases.at(-1);
    const summaries = [];
    for (const file of files.sort()) {
      const task = path.basename(file, '.log');
      if (!isTask.test(task)) continue;
      const state = readState(task);
      if (state.phases.find((row) => row.phase === last)?.state === 'done') continue;
      summaries.push({
        task,
        next: state.next,
        round: state.round,
        doneCount: state.phases.filter((row) => row.state === 'done' || row.state === 'skip').length,
        total: phases.length,
        open: state.phases.filter((row) => row.state === 'open').map((row) => row.phase),
        wip: state.phases.filter((row) => row.state === 'wip').map((row) => row.phase),
      });
    }
    return summaries;
  }

  function history(task) {
    assertTask(task);
    return parseJournal(readJournal(task), phases);
  }

  return { config, phases, readState, record, listTasks, history, parseDetail };
}
