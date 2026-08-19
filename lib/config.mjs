import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The pipeline is yours, so nothing here is baked into the code. This shape is a
// worked example rather than a recommendation: fifteen phases is a lot, and a team
// with five will be happier than a team that copied this one wholesale.
export const DEFAULT_CONFIG = {
  taskPattern: '[A-Z][A-Z0-9]*-\\d+',
  stateDir: '~/.local/state/wipline',
  phases: [
    { name: 'start', stage: 'planning' },
    { name: 'spec', stage: 'planning' },
    { name: 'plan', stage: 'planning' },
    { name: 'dev', stage: 'build' },
    { name: 'checks', stage: 'build' },
    { name: 'code-review', stage: 'review' },
    { name: 'qa', stage: 'testing' },
    { name: 'mr', stage: 'handover' },
    { name: 'mr-review', stage: 'handover' },
    { name: 'merged', stage: 'handover' },
    { name: 'cleanup', stage: 'handover' },
  ],
};

const FILENAME = 'wipline.json';

export function expandHome(target) {
  if (!target.startsWith('~')) return target;
  return path.join(os.homedir(), target.slice(1));
}

// Project config wins over user config: the phases belong to the repository, while
// the state directory is usually a machine-wide preference.
function locations(cwd) {
  const user = path.join(os.homedir(), '.config', 'wipline', 'config.json');
  const project = [];
  let dir = cwd;
  while (true) {
    project.push(path.join(dir, `.${FILENAME}`));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { user, project };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig(cwd = process.cwd()) {
  const { user, project } = locations(cwd);
  const merged = { ...DEFAULT_CONFIG, ...(readJson(user) ?? {}) };

  for (const candidate of project) {
    const found = readJson(candidate);
    if (found) {
      Object.assign(merged, found);
      merged.configPath = candidate;
      break;
    }
  }

  if (process.env.WIPLINE_STATE_DIR) merged.stateDir = process.env.WIPLINE_STATE_DIR;
  merged.stateDir = expandHome(merged.stateDir);

  const invalid = merged.phases.find((phase) => !phase?.name || !phase?.stage);
  if (invalid) {
    throw new Error(`every phase needs a name and a stage; got ${JSON.stringify(invalid)}`);
  }
  // Contiguity is a rendering contract, not a preference: the pane opens a new
  // group whenever the stage changes, so a stage appearing twice draws twice.
  const seen = [];
  let previous = '';
  for (const phase of merged.phases) {
    if (phase.stage === previous) continue;
    if (seen.includes(phase.stage)) {
      throw new Error(`stage "${phase.stage}" is not contiguous — phases sharing a stage must be adjacent`);
    }
    seen.push(phase.stage);
    previous = phase.stage;
  }

  return merged;
}

export function taskRegExp(config) {
  return new RegExp(`^${config.taskPattern}$`);
}

export function findTaskIn(text, config) {
  const match = String(text ?? '').match(new RegExp(config.taskPattern));
  return match ? match[0] : null;
}
