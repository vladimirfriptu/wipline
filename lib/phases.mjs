// The phase vocabulary and the fold that turns a journal into current state.
// Pure: no I/O, no config loading — callers pass the phase list in.

// `clear` unrecords one phase and nothing else; `reset` unrecords it and every
// later one. `wip` says "being worked on right now" and needs no rule to come off:
// any later record for the same phase replaces it. All of them are events, never
// deletions — the journal stays append-only.
export const STATES = ['done', 'open', 'skip', 'reset', 'clear', 'wip'];

export function phaseNames(config) {
  return config.phases.map((phase) => phase.name);
}

export function stageMap(config) {
  return Object.fromEntries(config.phases.map((phase) => [phase.name, phase.stage]));
}

export function stageOf(config, phase) {
  return stageMap(config)[phase] ?? '';
}

export function parseDetail(detail) {
  const pairs = detail.trim().split(/\s+/);
  const parsed = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const key = pair.slice(0, eq);
    parsed[key] = pair.slice(eq + 1);
  }
  return parsed;
}

export function parseJournal(text, phases) {
  const lines = text.split('\n');
  const records = [];
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const [ts, phase, state] = fields;
    if (!phases.includes(phase)) continue;
    if (!STATES.includes(state)) continue;
    records.push({
      ts,
      phase,
      state,
      by: fields[3] ?? '',
      detail: fields[4] ?? '',
    });
  }
  return records;
}

const PASSED_STATES = ['done', 'skip'];

export function fold(records, phases, options = {}) {
  const recorded = {};
  let round = 1;

  for (const record of records) {
    if (record.state === 'reset') {
      round += 1;
      const from = phases.indexOf(record.phase);
      for (const name of phases.slice(from)) delete recorded[name];
      continue;
    }
    if (record.state === 'clear') {
      // No round bump: correcting one tick is not another trip through the
      // pipeline, and counting it as one would inflate every task's history.
      delete recorded[record.phase];
      continue;
    }
    recorded[record.phase] = record;
  }

  // Staleness applies to any phase whose record was stamped with the commit it was
  // true at — `head=<sha>` in the detail. Once the branch moves on, that phase is
  // reported open again, because "the suite passed" stopped being a fact about the
  // current code. Must run before NEXT, or the task reports a later phase as next.
  if (options.head) {
    for (const [name, record] of Object.entries(recorded)) {
      if (record.state !== 'done') continue;
      const stampedAt = parseDetail(record.detail).head;
      if (!stampedAt || stampedAt === options.head) continue;
      recorded[name] = {
        ...record,
        state: 'open',
        detail: `${record.detail} reason=stale`.trim(),
      };
    }
  }

  const hasPassed = (name) => PASSED_STATES.includes(recorded[name]?.state);
  const next = phases.find((name) => !hasPassed(name)) ?? null;
  const doneCount = phases.filter(hasPassed).length;

  return { round, phases: recorded, next, doneCount };
}

// Automation tends to report the same closure repeatedly — a file watcher firing on
// every save, a CI hook on every push. Identical repeats are journal noise: the fold
// ignores them anyway, and only `history` suffers.
export function isDuplicate(folded, phase, state, detail) {
  const current = folded.phases[phase];
  // Clearing a phase that carries no record does nothing, so it is noise too.
  if (!current) return state === 'clear';
  return current.state === state && current.detail === detail;
}

export function formatLine(folded, task, total) {
  const parts = [task, folded.next ?? 'done', `${folded.doneCount}/${total}`];
  if (folded.round > 1) parts.push(`↻${folded.round}`);
  return parts.join(' ');
}
