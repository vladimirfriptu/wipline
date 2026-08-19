import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, taskRegExp, findTaskIn, expandHome } from '../lib/config.mjs';

function tempProject(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipline-cfg-'));
  if (config) fs.writeFileSync(path.join(dir, '.wipline.json'), JSON.stringify(config));
  return dir;
}

test('the default config is a usable pipeline with contiguous stages', () => {
  const config = loadConfig(tempProject());

  assert.ok(config.phases.length > 0);
  for (const phase of config.phases) {
    assert.equal(typeof phase.name, 'string');
    assert.equal(typeof phase.stage, 'string');
  }
});

test('a project config replaces the phases wholesale', () => {
  const dir = tempProject({
    phases: [{ name: 'code', stage: 'work' }, { name: 'ship', stage: 'release' }],
  });

  const config = loadConfig(dir);

  assert.deepEqual(config.phases.map((p) => p.name), ['code', 'ship']);
  assert.equal(config.configPath, path.join(dir, '.wipline.json'));
});

test('a project config is found from a subdirectory', () => {
  const dir = tempProject({ phases: [{ name: 'code', stage: 'work' }] });
  const nested = path.join(dir, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });

  assert.deepEqual(loadConfig(nested).phases.map((p) => p.name), ['code']);
});

test('non-contiguous stages are rejected, because they would render as two groups', () => {
  const dir = tempProject({
    phases: [
      { name: 'a', stage: 'one' },
      { name: 'b', stage: 'two' },
      { name: 'c', stage: 'one' },
    ],
  });

  assert.throws(() => loadConfig(dir), /not contiguous/);
});

test('a phase missing its name or stage is rejected', () => {
  const noStage = tempProject({ phases: [{ name: 'a' }] });
  const noName = tempProject({ phases: [{ stage: 'one' }] });

  assert.throws(() => loadConfig(noStage), /needs a name and a stage/);
  assert.throws(() => loadConfig(noName), /needs a name and a stage/);
});

test('WIPLINE_STATE_DIR overrides the configured state directory', () => {
  const dir = tempProject({ stateDir: '/from/config' });
  const previous = process.env.WIPLINE_STATE_DIR;
  process.env.WIPLINE_STATE_DIR = '/from/env';
  try {
    assert.equal(loadConfig(dir).stateDir, '/from/env');
  } finally {
    if (previous === undefined) delete process.env.WIPLINE_STATE_DIR;
    else process.env.WIPLINE_STATE_DIR = previous;
  }
});

test('a tilde in stateDir expands to the home directory', () => {
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'));
  assert.equal(expandHome('/absolute/x'), '/absolute/x');
});

test('the task pattern is configurable and anchored when matching a whole key', () => {
  const jira = { ...DEFAULT_CONFIG };
  const numeric = { ...DEFAULT_CONFIG, taskPattern: '#\\d+' };

  assert.equal(taskRegExp(jira).test('ACME-42'), true);
  assert.equal(taskRegExp(jira).test('acme-42'), false);
  assert.equal(taskRegExp(jira).test('x ACME-42'), false);
  assert.equal(taskRegExp(numeric).test('#42'), true);
});

test('findTaskIn pulls a key out of a branch name or a tab title', () => {
  assert.equal(findTaskIn('feature/ACME-42-thing', DEFAULT_CONFIG), 'ACME-42');
  assert.equal(findTaskIn('[2] ACME-42 (waiting)', DEFAULT_CONFIG), 'ACME-42');
  assert.equal(findTaskIn('no key here', DEFAULT_CONFIG), null);
  assert.equal(findTaskIn(undefined, DEFAULT_CONFIG), null);
});
