#!/usr/bin/env node
// Offline tests for scripts/model-budget.mjs and the shipped default sheet templates/pstack-models.md (SID-143).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE, check, configsFrom, install, parseSheet, sheetPath } from './model-budget.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'model-budget.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'sflow-test-model-budget-'));
const quiet = { log: () => {} };
const cli = (args, env = {}) => {
  try { return { code: 0, out: execFileSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok   ${name}`); };

try {
  const template = readFileSync(TEMPLATE, 'utf8');
  const { roles, problems } = parseSheet(template);
  const models = (role) => roles.get(role).map((e) => e.split(/\s+/)[0]);

  t('m1: the default sheet parses with no problems', () => assert.deepEqual(problems, []));
  t('m2: workers and reviewers run on sonnet', () => {
    for (const r of ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'swarm workers', 'arena runners', 'interrogate reviewers', 'how explorer', 'how explainer', 'why investigators', 'reflect tooling'])
      assert.ok(models(r).every((m) => m === 'sonnet'), `${r}: ${roles.get(r)}`);
  });
  t('m3: opus only for architecture and verdicts', () => {
    const opusRoles = [...roles].filter(([, es]) => es.some((e) => e.startsWith('opus'))).map(([r]) => r).sort();
    assert.deepEqual(opusRoles, ['architect runners', 'arena cross-judge pool', 'hardest tasks', 'judgment and prose', 'reflect judgment, divergent, synthesizer', 'why synthesizer']);
  });
  t('m4: haiku for mechanical work, and nothing runs on fable or above high effort', () => {
    assert.deepEqual([...roles].filter(([, es]) => es.some((e) => e.startsWith('haiku'))).map(([r]) => r.split(' (')[0]), ['mechanical work']);
    for (const [r, es] of roles) for (const e of es) {
      assert.notEqual(e.split(/\s+/)[0], 'fable', r);
      assert.ok(!/\b(xhigh|max)\b/.test(e), `${r}: ${e}`);
    }
  });
  t('m5: every pstack role from setup-pstack has a line', () => {
    for (const r of ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment and prose', 'hardest tasks', 'how explorer', 'how explainer', 'why investigators', 'why synthesizer', 'reflect tooling', 'reflect judgment, divergent, synthesizer', 'arena runners', 'arena cross-judge pool', 'swarm workers', 'architect runners', 'interrogate reviewers'])
      assert.ok(roles.has(r), r);
  });
  t('m6: the sheet sets no permissions and carries no frontmatter', () => {
    assert.ok(!template.startsWith('---'));
    assert.doesNotMatch(template, /permissions|allow(ed)?Tools|additionalDirectories|--add-dir/i);
  });

  const a = join(tmp, 'a'), b = join(tmp, 'b config');
  t('i1: install writes the sheet into every config, then check passes', () => {
    install([a, b], quiet);
    for (const c of [a, b]) assert.equal(readFileSync(sheetPath(c), 'utf8'), template);
    assert.equal(check([a, b], quiet), true);
  });
  t('i2: install is idempotent', () => {
    const lines = []; install([a], { log: (l) => lines.push(l) });
    assert.match(lines[0], /^current /);
  });
  t('i3: a sheet that differs is kept without --force and replaced with it', () => {
    const custom = '# mine\nswarm workers: opus xhigh\n';
    writeFileSync(sheetPath(a), custom);
    const lines = []; install([a], { log: (l) => lines.push(l) });
    assert.match(lines[0], /^kept /);
    assert.equal(readFileSync(sheetPath(a), 'utf8'), custom);
    const out = []; assert.equal(check([a], { log: (l) => out.push(l) }), true);
    assert.match(out[0], /^ok custom .*swarm workers: opus xhigh/);
    const forced = []; install([a], { force: true, log: (l) => forced.push(l), now: () => new Date('2026-11-01T00:55:00.123Z') });
    assert.equal(readFileSync(sheetPath(a), 'utf8'), template);
    const bak = `${sheetPath(a)}.bak-20261101T005500Z`;
    assert.ok(existsSync(bak), 'the customised sheet is backed up before --force replaces it');
    assert.equal(readFileSync(bak, 'utf8'), custom, 'the backup holds the custom text');
    assert.ok(!bak.endsWith('.md'), 'the backup is not a .md (Claude Code loads every .md in rules/)');
    assert.ok(forced.some((l) => l.includes(`backed up ${sheetPath(a)} -> ${bak}`)), 'the backup path is logged');
    assert.deepEqual(readdirSync(join(a, 'rules')).filter((f) => f.endsWith('.md')), ['pstack-models.md'], 'only one sheet loads');
    writeFileSync(sheetPath(a), custom); install([a], { ...quiet, force: true, now: () => new Date('2026-11-01T00:55:00.999Z') });
    assert.equal(readFileSync(`${bak}-1`, 'utf8'), custom, 'a second backup in the same second does not overwrite the first');
    install([a], { ...quiet, force: true });
    assert.ok(!readdirSync(join(a, 'rules')).some((f) => f.endsWith('-2')), 'an unchanged sheet is not backed up again');
  });
  t('i5: a symlink at the sheet path is refused, with or without --force, and its target is untouched', () => {
    const c = join(tmp, 'link'), target = join(tmp, 'link-target.md');
    mkdirSync(join(c, 'rules'), { recursive: true }); writeFileSync(target, 'swarm workers: opus high\n'); symlinkSync(target, sheetPath(c));
    for (const force of [false, true]) {
      const lines = []; assert.equal(install([c], { force, log: (l) => lines.push(l) }), false);
      assert.match(lines[0], /^refused .*symlink/);
      assert.equal(readFileSync(target, 'utf8'), 'swarm workers: opus high\n');
    }
    const r = cli(['install', '--force', '--config', c]); assert.equal(r.code, 1); assert.match(r.out, /refused/);
  });
  t('c1: check fails on a missing sheet and names the install command', () => {
    const r = cli(['check', '--config', join(tmp, 'none')]);
    assert.equal(r.code, 1); assert.match(r.out, /MISSING .*model-budget -- install --config/);
  });
  t('c2: check fails on an unknown model or effort, and on a sheet with no roles', () => {
    for (const [body, want] of [['swarm workers: gpt-6.1-sol\n', /unknown model "gpt-6.1-sol"/], ['swarm workers: sonnet turbo\n', /unknown effort "turbo"/], ['# only comments\n', /no role lines/], ['swarm workers sonnet\n', /not "role: model"/]]) {
      const c = join(tmp, `bad-${n}-${want.source.length}`); mkdirSync(join(c, 'rules'), { recursive: true }); writeFileSync(sheetPath(c), body);
      const r = cli(['check', '--config', c]);
      assert.equal(r.code, 1, body); assert.match(r.out, want);
    }
  });
  t('c3: aliases and one bad config among good ones', () => {
    assert.deepEqual(parseSheet('swarm workers: inherit-parent\narena runners: auto, sonnet\n').problems, []);
    const bad = join(tmp, 'bad-mixed'); mkdirSync(join(bad, 'rules'), { recursive: true }); writeFileSync(sheetPath(bad), 'swarm workers: gpt\n');
    assert.equal(check([b, bad], quiet), false);
  });
  t('c4: config defaults to $CLAUDE_CONFIG_DIR, then ~/.claude; CLI install + check exit 0', () => {
    assert.deepEqual(configsFrom([], { CLAUDE_CONFIG_DIR: join(tmp, 'env') }), [join(tmp, 'env')]);
    assert.ok(configsFrom([], {})[0].endsWith('.claude'));
    const r = cli(['install'], { CLAUDE_CONFIG_DIR: join(tmp, 'env') });
    assert.equal(r.code, 0, r.out); assert.ok(existsSync(sheetPath(join(tmp, 'env'))));
  });
  t('c5: usage errors exit 2', () => {
    assert.equal(cli([]).code, 2); assert.equal(cli(['check', '--nope']).code, 2); assert.equal(cli(['check', '--config']).code, 2);
  });
  t('c6: install writes only <config>/rules/pstack-models.md', () => {
    const c = join(tmp, 'only'); install([c], quiet);
    assert.deepEqual(execFileSync('find', [c, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n'), [sheetPath(c)]);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`model-budget tests ok: ${n}`);
