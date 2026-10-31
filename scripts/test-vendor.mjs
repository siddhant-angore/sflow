#!/usr/bin/env node
// Offline tests for scripts/vendor.mjs sync and check, and for scripts/check-versions.mjs. Every fixture upstream is a local git repo fetched
// over file:// at its HEAD sha (real git, no network); every fixture sflow root has its own copy of the scripts and its own TMPDIR.
//   node scripts/test-vendor.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionProblems } from './check-versions.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENABLE_ORPHAN_TEST = false; // main does not remove orphan LICENSES yet; PR #10 (SID-46) adds it
const POTETO = { 'skills/poteto-mode/SKILL.md': '---\nname: poteto-mode\n---\n- **Opening a PR.** Invoked at the end of every other playbook.\n', 'skills/poteto-mode/playbooks/x.md': '# x\n\n1. Do the thing.\n' };

const withTmp = (fn) => {
  const tmp = mkdtempSync(join(tmpdir(), 'sflow-sid51-'));
  try { return fn(tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
};
const env = (tmp) => ({ ...process.env, TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1' });
const git = (tmp, dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { env: env(tmp), stdio: 'pipe', encoding: 'utf8' }).trim();

// files: path -> text, { link: target }, or null (omit). LICENSE is added unless the files say null.
function upstream(tmp, name, files) {
  const dir = join(tmp, 'up', name);
  mkdirSync(dir, { recursive: true });
  git(tmp, dir, 'init', '-q');
  git(tmp, dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(tmp, dir, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const put = (all) => {
    for (const [p, v] of Object.entries(all)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      if (v === null) continue;
      if (typeof v === 'string') writeFileSync(join(dir, p), v); else symlinkSync(v.link, join(dir, p));
    }
    git(tmp, dir, 'add', '-A'); git(tmp, dir, 'commit', '-q', '-m', 'c');
    return git(tmp, dir, 'rev-parse', 'HEAD');
  };
  const sha = put({ LICENSE: `licence of ${name}\n`, ...files });
  const sha2 = put({ 'second.txt': 'two\n' });
  return { url: `file://${dir}`, sha, sha2, source: (extra = {}) => ({ repo: `file://${dir}`, sha, license: 'MIT', ...extra }) };
}

function fixture(tmp, manifest) {
  const root = join(tmp, 'root');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'workflows'));
  for (const f of ['vendor.mjs', 'build-workflows.mjs', 'check-domain-playbooks.mjs']) copyFileSync(join(repoRoot, 'scripts', f), join(root, 'scripts', f));
  const f = { root, setManifest: (m) => writeFileSync(join(root, 'vendor.manifest.json'), JSON.stringify(m, null, 2)) };
  f.setManifest(manifest);
  const run = (mode) => { const r = spawnSync('node', [join(root, 'scripts', 'vendor.mjs'), mode], { cwd: root, env: env(tmp), encoding: 'utf8', timeout: 20000 }); return { status: r.status, out: r.stdout + r.stderr }; };
  f.sync = () => run('sync'); f.check = () => run('check');
  f.read = (p) => readFileSync(join(root, p), 'utf8');
  f.goodSync = () => { const r = f.sync(); assert.equal(r.status, 0, r.out); return r; };
  return f;
}

// One source `up` with every `skills/*` entry copied to skills; the usual shape.
const simple = (tmp, files, entry = {}, extra = {}) => {
  const up = upstream(tmp, 'up', files);
  return { up, f: fixture(tmp, { sources: { up: up.source(extra) }, entries: [{ source: 'up', from: 'skills/*', to: 'skills', ...entry }] }) };
};
const SKILL = (n) => `---\nname: ${n}\ndescription: d\n---\nbody of ${n}\n`;
const lines = (out, s) => out.split('\n').filter((l) => l.includes(s));
const walkAll = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkAll(join(dir, e.name)) : [join(dir, e.name)]);
const snapshot = (dir) => Object.fromEntries(walkAll(dir).map((p) => [p.slice(dir.length), lstatSync(p).isSymbolicLink() ? `link ${readlinkSync(p)}` : createHash('sha256').update(readFileSync(p)).digest('hex')]));

const tests = [
  ['a: a relative symlink inside a copied dir becomes a regular file', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/a/ref.md': { link: '../shared.md' }, 'skills/shared.md': 'shared text\n' });
    f.goodSync();
    const p = join(f.root, 'skills/a/ref.md');
    assert.equal(lstatSync(p).isSymbolicLink(), false);
    assert.equal(readFileSync(p, 'utf8'), 'shared text\n');
    assert.deepEqual(walkAll(f.root).filter((x) => lstatSync(x).isSymbolicLink()), []);
    const c = f.check(); assert.equal(c.status, 0, c.out);
  })],
  ['b: a symlink that escapes the checkout fails sync', () => withTmp((tmp) => {
    writeFileSync(join(tmp, 'secret.txt'), 'secret\n');
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/a/out.md': { link: join(tmp, 'secret.txt') } });
    const r = f.sync(); assert.notEqual(r.status, 0); assert.match(r.out, /symlink escapes the source checkout/);
  })],
  ['c: a symlink loop fails fast and names the link and its target', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/a/loop': { link: '..' } });
    const t0 = Date.now(), r = f.sync();
    assert.notEqual(r.status, 0); assert.match(r.out, /symlink loop in up: skills\/a\/loop -> \.\./); assert.ok(Date.now() - t0 < 10000);
  })],
  ['d: a broken upstream link fails with a readable error', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/a/dangling': { link: 'nope.md' } });
    const r = f.sync(); assert.notEqual(r.status, 0);
    assert.match(r.out, /broken symlink in up: skills\/a\/dangling -> nope\.md/); assert.doesNotMatch(r.out.split('\n').filter((l) => l.startsWith('Error:')).join('\n'), /ENOENT/);
  })],
  ['e: rename moves the directory and rewrites the SKILL.md name', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a') }, { rename: { a: 'a-renamed' } });
    f.goodSync();
    assert.match(f.read('skills/a-renamed/SKILL.md'), /^name: a-renamed$/m);
    assert.throws(() => f.read('skills/a/SKILL.md'));
  })],
  ['f: two sources writing one target collide', () => withTmp((tmp) => {
    const u1 = upstream(tmp, 'one', { 'skills/a/SKILL.md': SKILL('a') }), u2 = upstream(tmp, 'two', { 'skills/a/SKILL.md': SKILL('a') });
    const f = fixture(tmp, { sources: { one: u1.source(), two: u2.source() }, entries: [{ source: 'one', from: 'skills/*', to: 'skills' }, { source: 'two', from: 'skills/*', to: 'skills' }] });
    const r = f.sync(); assert.notEqual(r.status, 0); assert.match(r.out, /collision: skills\/a from one and two/);
  })],
  ['g: exclude skips a child', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/b/SKILL.md': SKILL('b') }, { exclude: ['b'] });
    f.goodSync(); assert.equal(f.read('skills/a/SKILL.md'), SKILL('a')); assert.throws(() => f.read('skills/b/SKILL.md'));
  })],
  ['h1: include on a /* entry takes only the named children', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/b/SKILL.md': SKILL('b') }, { include: ['a'] });
    f.goodSync(); assert.deepEqual(readdirSync(join(f.root, 'skills')), ['a']);
  })],
  ['h2: include on a directory entry takes only the named top-level children', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'extras/SKILL.md': SKILL('e'), 'extras/keep/k.md': 'k\n', 'extras/other.md': 'o\n', 'extras/skip/s.md': 's\n' }, { from: 'extras', to: 'out/extras', include: ['SKILL.md', 'keep'] });
    f.goodSync(); assert.deepEqual(readdirSync(join(f.root, 'out/extras')).sort(), ['SKILL.md', 'keep']); assert.equal(f.read('out/extras/keep/k.md'), 'k\n');
  })],
  ['i: licensePath picks a subpath licence, the default is LICENSE', () => withTmp((tmp) => {
    const u1 = upstream(tmp, 'one', { 'skills/a/SKILL.md': SKILL('a'), 'sub/LICENSE': 'SUB LICENCE\n' }), u2 = upstream(tmp, 'two', { 'skills/b/SKILL.md': SKILL('b') });
    const f = fixture(tmp, { sources: { 'org/one/sub': u1.source({ licensePath: 'sub/LICENSE' }), 'org/two': u2.source() }, entries: [{ source: 'org/one/sub', from: 'skills/*', to: 'skills' }, { source: 'org/two', from: 'skills/*', to: 'skills' }] });
    f.goodSync();
    assert.equal(f.read('LICENSES/org__one__sub.LICENSE'), 'SUB LICENCE\n'); assert.equal(f.read('LICENSES/org__two.LICENSE'), 'licence of two\n');
  })],
  ['j: a source with no LICENSE fails sync', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), LICENSE: null });
    const r = f.sync(); assert.notEqual(r.status, 0); assert.match(r.out, /LICENSE/);
  })],
  ['l1: check reports missing, drift and unexpected files', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), 'skills/a/f.md': 'f\n', 'skills/a/g.md': 'g\n' });
    f.goodSync();
    rmSync(join(f.root, 'skills/a/g.md')); writeFileSync(join(f.root, 'skills/a/f.md'), 'changed\n'); writeFileSync(join(f.root, 'skills/a/new.md'), 'n\n');
    const r = f.check(); assert.equal(r.status, 1);
    for (const s of ['missing: skills/a/g.md', 'drift: skills/a/f.md', 'unexpected (not in lock): skills/a/new.md']) assert.equal(lines(r.out, s).length, 1, `${s}\n${r.out}`);
  })],
  ['l2: check reports a manifest/lock sha mismatch', () => withTmp((tmp) => {
    const { up, f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a') });
    f.goodSync();
    f.setManifest({ sources: { up: up.source({ sha: up.sha2 }) }, entries: [{ source: 'up', from: 'skills/*', to: 'skills' }] });
    const r = f.check(); assert.equal(r.status, 1); assert.match(r.out, /manifest\/lock sha mismatch for up/);
  })],
  ['m: an unlocked symlink is reported once, as a symlink', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a') });
    f.goodSync(); symlinkSync('SKILL.md', join(f.root, 'skills/a/sneaky'));
    const r = f.check(); assert.equal(r.status, 1);
    assert.equal(lines(r.out, 'symlink: skills/a/sneaky').length, 1, r.out); assert.equal(lines(r.out, 'unexpected').length, 0, r.out);
  })],
  ['n: a stale overlay anchor fails sync', () => withTmp((tmp) => {
    const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a'), ...POTETO });
    writeFileSync(join(f.root, 'workflows/o.md'), '---\nextends: x\nwhen: test\n---\n# o\n- **After** "text that is not there": y\n');
    const r = f.sync(); assert.notEqual(r.status, 0); assert.match(r.out, /is not in x\.md/);
  })],
  ['o: a failed sync leaves the real tree byte-identical and no stage dir', () => withTmp((tmp) => {
    const u1 = upstream(tmp, 'one', { 'skills/a/SKILL.md': SKILL('a'), ...POTETO }), u2 = upstream(tmp, 'two', { 'skills/b/SKILL.md': SKILL('b'), 'skills/b/dangling': { link: 'nope.md' } });
    const f = fixture(tmp, { sources: { one: u1.source() }, entries: [{ source: 'one', from: 'skills/*', to: 'skills' }] });
    f.goodSync();
    f.setManifest({ sources: { one: u1.source(), two: u2.source() }, entries: [{ source: 'one', from: 'skills/*', to: 'skills' }, { source: 'two', from: 'skills/*', to: 'more' }] });
    const before = snapshot(f.root), r = f.sync();
    assert.notEqual(r.status, 0); assert.match(r.out, /broken symlink in two/);
    assert.deepEqual(snapshot(f.root), before);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('sflow-vendor-stage-')), []);
  })],
  ['p: the four version fields must agree', () => withTmp((tmp) => {
    const files = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'domains/flutter/.claude-plugin/plugin.json'];
    const reset = () => { for (const p of files) { mkdirSync(dirname(join(tmp, p)), { recursive: true }); copyFileSync(join(repoRoot, p), join(tmp, p)); } };
    const edit = (p, fn) => { const j = JSON.parse(readFileSync(join(tmp, p), 'utf8')); fn(j); writeFileSync(join(tmp, p), JSON.stringify(j)); };
    reset(); assert.deepEqual(versionProblems(tmp), []);
    const cases = [
      ['.claude-plugin/plugin.json version', files[0], (j) => { j.version = '9.9.9'; }],
      ['plugins[sflow].version', files[1], (j) => { j.plugins.find((x) => x.name === 'sflow').version = '9.9.9'; }],
      ['plugins[sflow-flutter].version', files[1], (j) => { j.plugins.find((x) => x.name === 'sflow-flutter').version = '9.9.9'; }],
      ['domains/flutter/.claude-plugin/plugin.json version', files[2], (j) => { j.version = '9.9.9'; }],
    ];
    for (const [label, p, fn] of cases) {
      reset(); edit(p, fn);
      const got = versionProblems(tmp);
      assert.ok(got.some((x) => x.includes('disagreement') && x.includes(`${label} = 9.9.9`)), `${label}: ${got}`);
    }
    reset(); edit(files[1], (j) => { j.plugins = j.plugins.filter((x) => x.name !== 'sflow-flutter'); });
    assert.ok(versionProblems(tmp).some((x) => x.includes('missing marketplace entry: sflow-flutter')));
    reset(); edit(files[0], (j) => { delete j.version; });
    assert.ok(versionProblems(tmp).some((x) => x.includes('missing field: .claude-plugin/plugin.json version')));
    rmSync(join(tmp, files[2]));
    assert.ok(versionProblems(tmp).some((x) => x.includes(`missing file: ${files[2]}`)));
    const r = spawnSync('node', [join(repoRoot, 'scripts/check-versions.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /versions ok: \S+ \(4 fields agree\)/);
  })],
];

const orphan = ['k: a LICENSES file no source owns is removed by sync', () => withTmp((tmp) => {
  const { f } = simple(tmp, { 'skills/a/SKILL.md': SKILL('a') });
  f.goodSync(); writeFileSync(join(f.root, 'LICENSES/bogus.LICENSE'), 'x\n'); f.goodSync();
  assert.throws(() => f.read('LICENSES/bogus.LICENSE'));
})];
if (ENABLE_ORPHAN_TEST) tests.push(orphan); else console.log(`todo ${orphan[0]} (lands with #10, SID-46)`);

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); }
}
if (failed) { console.error(`${failed} of ${tests.length} vendor tests failed`); process.exit(1); }
console.log(`vendor tests ok: ${tests.length}`);
