#!/usr/bin/env node
// Offline tests for scripts/upstream.mjs. A stub git runner models a tiny upstream history; no network, no real git.
//   node scripts/test-upstream.mjs
import assert from 'node:assert/strict';
import { buildReport, formatText, localToUpstream, readOverlays } from './upstream.mjs';

// Fake upstream: commits oldest-first, each { sha, changes: { path: 'A'|'M'|'D' } }. `orphans` exist on the server but are not on the default branch.
function fakeRepo({ commits, orphans = [], branch = 'main' }) {
  const treeAt = (sha) => {
    const t = new Set();
    for (const c of commits) { for (const [p, st] of Object.entries(c.changes)) st === 'D' ? t.delete(p) : t.add(p); if (c.sha === sha) break; }
    return t;
  };
  const idx = (sha) => commits.findIndex((c) => c.sha === sha);
  const matcher = (specs) => {
    const pos = specs.filter((s) => !s.startsWith(':(exclude)')), neg = specs.filter((s) => s.startsWith(':(exclude)')).map((s) => s.slice(10));
    const under = (p, s) => p === s || p.startsWith(s + '/');
    return (p) => (!pos.length || pos.some((s) => under(p, s))) && !neg.some((s) => under(p, s));
  };
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const [cmd, ...rest] = args;
    const split = rest.indexOf('--');
    const specs = split < 0 ? [] : rest.slice(split + 1);
    const pre = split < 0 ? rest : rest.slice(0, split);
    if (cmd === 'cat-file') { const sha = pre[1].replace('^{commit}', ''); if (idx(sha) >= 0 || orphans.includes(sha)) return ''; throw new Error('bad object'); }
    if (cmd === 'merge-base') { if (idx(pre[1]) >= 0 && idx(pre[1]) <= idx(pre[2])) return ''; throw new Error('not ancestor'); }
    if (cmd === 'rev-list') {
      const [a, b] = pre[1].split('..'); const m = matcher(specs);
      return String(commits.slice(idx(a) + 1, idx(b) + 1).filter((c) => !specs.length || Object.keys(c.changes).some(m)).length) + '\n';
    }
    if (cmd === 'diff') {
      const [a, b] = pre.slice(2); const m = matcher(specs), ta = treeAt(a), tb = treeAt(b);
      const touched = new Set(commits.slice(idx(a) + 1, idx(b) + 1).flatMap((c) => Object.keys(c.changes)));
      return [...new Set([...ta, ...tb])].filter((p) => m(p) && (ta.has(p) !== tb.has(p) || touched.has(p)))
        .map((p) => `${!ta.has(p) ? 'A' : !tb.has(p) ? 'D' : 'M'}\t${p}`).join('\n');
    }
    if (cmd === 'ls-tree') {
      const base = pre[1]; const seen = new Map();
      for (const p of treeAt(pre[0])) if (p.startsWith(base)) { const [first, ...more] = p.slice(base.length).split('/'); seen.set(first, more.length ? 'tree' : 'blob'); }
      return [...seen].map(([n, t]) => `100644 ${t} deadbeef\t${base}${n}`).join('\n');
    }
    throw new Error(`stub git: unhandled ${args.join(' ')}`);
  };
  const head = commits.at(-1).sha;
  return { handle: { head, branch, git }, calls };
}

const sha = (c) => c.repeat(40);
const A = sha('a'), B = sha('b'), C = sha('c'), D = sha('d');
const manifestFor = (sources, entries) => ({ sources, entries });
const lockFor = (manifest) => ({ sources: structuredClone(manifest.sources) });
const src = (repo, pin) => ({ repo, sha: pin, license: 'MIT' });
const run = (manifest, repos, extra = {}) => {
  const opened = [];
  const report = buildReport({ manifest, lock: extra.lock ?? lockFor(manifest), overlays: extra.overlays, exists: extra.exists,
    openRepo: (url) => { opened.push(url); if (!repos[url]) throw new Error('fatal: unable to access (stub network down)'); return repos[url].handle; } });
  return { report, opened };
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const pstackManifest = manifestFor({ p: src('https://github.com/o/p', A) },
  [{ source: 'p', from: 'plugins/pstack/skills/*', to: 'skills' }, { source: 'p', from: 'plugins/pstack/README.md', to: 'docs/p.md' }]);

test('current: pin equals head', () => {
  const r = fakeRepo({ commits: [{ sha: A, changes: { 'plugins/pstack/skills/x/SKILL.md': 'A' } }] });
  const { report } = run(pstackManifest, { 'https://github.com/o/p': r });
  assert.equal(report.sources[0].status, 'current');
  assert.equal(report.exitCode, 0);
  assert.equal(report.sources[0].branch, 'main');
});

test('behind: relevant commits counted, files and compare link listed', () => {
  const r = fakeRepo({ commits: [
    { sha: A, changes: { 'plugins/pstack/skills/x/SKILL.md': 'A' } },
    { sha: B, changes: { 'plugins/pstack/skills/x/SKILL.md': 'M' } },
    { sha: C, changes: { 'plugins/pstack/README.md': 'A' } }] });
  const { report } = run(pstackManifest, { 'https://github.com/o/p': r });
  const s = report.sources[0];
  assert.equal(s.status, 'behind');
  assert.equal(s.relevantAhead, 2);
  assert.equal(s.totalAhead, 2);
  assert.deepEqual(s.changed.map((c) => `${c.status} ${c.path}`).sort(), ['A plugins/pstack/README.md', 'M plugins/pstack/skills/x/SKILL.md']);
  assert.equal(s.compare, `https://github.com/o/p/compare/${A.slice(0, 12)}...${C.slice(0, 12)}`);
  assert.equal(report.exitCode, 10);
  assert.match(formatText(report), /BEHIND/);
});

test('unrelated monorepo commits do not count, and stay current', () => {
  const r = fakeRepo({ commits: [
    { sha: A, changes: { 'plugins/pstack/skills/x/SKILL.md': 'A' } },
    { sha: B, changes: { 'third_party/logo.png': 'M' } },
    { sha: C, changes: { 'plugins/other/README.md': 'M' } }] });
  const { report } = run(pstackManifest, { 'https://github.com/o/p': r });
  const s = report.sources[0];
  assert.equal(s.relevantAhead, 0);
  assert.equal(s.totalAhead, 2);
  assert.equal(s.status, 'current');
  assert.equal(report.exitCode, 0);
});

test('pinned sha missing upstream is an error (exit 1) even when another source drifted', () => {
  const m = manifestFor({ gone: src('https://github.com/o/g', D), p: src('https://github.com/o/p', A) },
    [{ source: 'gone', from: 'skills/*', to: 'skills' }, { source: 'p', from: 'skills/*', to: 'skills2' }]);
  const g = fakeRepo({ commits: [{ sha: B, changes: { 'skills/a/SKILL.md': 'A' } }] });
  const p = fakeRepo({ commits: [{ sha: A, changes: { 'skills/a/SKILL.md': 'A' } }, { sha: C, changes: { 'skills/a/SKILL.md': 'M' } }] });
  const { report } = run(m, { 'https://github.com/o/g': g, 'https://github.com/o/p': p });
  assert.equal(report.sources[0].status, 'error');
  assert.match(report.sources[0].errors[0], /no longer exists upstream/);
  assert.equal(report.sources[1].status, 'behind');
  assert.equal(report.exitCode, 1);
});

test('pin that exists but is not an ancestor of head is an error', () => {
  const r = fakeRepo({ commits: [{ sha: B, changes: { 'skills/a/SKILL.md': 'A' } }], orphans: [A] });
  const m = manifestFor({ s: src('https://github.com/o/s', A) }, [{ source: 's', from: 'skills/*', to: 'skills' }]);
  const { report } = run(m, { 'https://github.com/o/s': r });
  assert.equal(report.sources[0].status, 'error');
  assert.match(report.sources[0].errors[0], /not an ancestor/);
  assert.equal(report.exitCode, 1);
});

test('manifest and lock sha mismatch is an error', () => {
  const r = fakeRepo({ commits: [{ sha: A, changes: { 'plugins/pstack/README.md': 'A' } }] });
  const lock = { sources: { p: src('https://github.com/o/p', B) } };
  const { report } = run(pstackManifest, { 'https://github.com/o/p': r }, { lock });
  assert.equal(report.sources[0].status, 'error');
  assert.match(report.sources[0].errors[0], /manifest\/lock sha mismatch/);
  assert.equal(report.exitCode, 1);
});

test('network failure is an error', () => {
  const { report } = run(pstackManifest, {});
  assert.equal(report.sources[0].status, 'error');
  assert.match(report.sources[0].errors[0], /cannot reach upstream/);
  assert.equal(report.exitCode, 1);
});

test('source keys sharing one repo are fetched once and filtered to their own paths', () => {
  const repo = 'https://github.com/cursor/plugins';
  const m = manifestFor({ 'cursor/a': src(repo, A), 'cursor/b': src(repo, A) }, [
    { source: 'cursor/a', from: 'pstack/skills/*', to: 'skills', include: ['plan'] },
    { source: 'cursor/b', from: 'pstack/agents', to: 'agents' }]);
  const r = fakeRepo({ commits: [
    { sha: A, changes: { 'pstack/skills/plan/SKILL.md': 'A', 'pstack/agents/x.md': 'A', 'pstack/skills/other/SKILL.md': 'A' } },
    { sha: B, changes: { 'pstack/skills/other/SKILL.md': 'M' } },
    { sha: C, changes: { 'pstack/agents/x.md': 'M' } }] });
  const { report, opened } = run(m, { [repo]: r });
  assert.deepEqual(opened, [repo]);
  const [a, b] = report.sources;
  assert.equal(a.relevantAhead, 0, 'include list limits a to pstack/skills/plan');
  assert.equal(a.status, 'current');
  assert.equal(b.relevantAhead, 1);
  assert.equal(b.status, 'behind');
  assert.equal(report.exitCode, 10);
});

test('new and removed skill dirs, rename, exclude, and collision', () => {
  const m = manifestFor({ s: src('https://github.com/o/s', A) },
    [{ source: 's', from: 'skills/*', to: 'skills', rename: { teach: 'teach-workspace' }, exclude: ['shared'] }]);
  const r = fakeRepo({ commits: [
    { sha: A, changes: { 'skills/old/SKILL.md': 'A', 'skills/keep/SKILL.md': 'A' } },
    { sha: B, changes: { 'skills/old/SKILL.md': 'D', 'skills/fresh/SKILL.md': 'A', 'skills/teach/SKILL.md': 'A', 'skills/shared/x.md': 'A' } }] });
  const { report } = run(m, { 'https://github.com/o/s': r }, { exists: (p) => p === 'skills/teach-workspace' });
  const s = report.sources[0];
  assert.deepEqual(s.newSkills.map((n) => [n.name, n.to, n.collision]).sort(),
    [['fresh', 'skills/fresh', false], ['teach', 'skills/teach-workspace', true]]);
  assert.deepEqual(s.removedSkills.map((n) => n.name), ['old']);
  assert.match(formatText(report), /COLLISION/);
});

test('overlay flag when the upstream twin of an anchored file changed', () => {
  const r = fakeRepo({ commits: [
    { sha: A, changes: { 'plugins/pstack/skills/poteto-mode/playbooks/bug-fix.md': 'A', 'plugins/pstack/skills/poteto-mode/playbooks/spec.md': 'A' } },
    { sha: B, changes: { 'plugins/pstack/skills/poteto-mode/playbooks/bug-fix.md': 'M' } }] });
  const overlays = [{ overlay: 'workflows/bug-fix.md', target: 'skills/poteto-mode/playbooks/bug-fix.md' },
    { overlay: 'workflows/spec.md', target: 'skills/poteto-mode/playbooks/spec.md' }];
  const { report } = run(pstackManifest, { 'https://github.com/o/p': r }, { overlays });
  assert.deepEqual(report.sources[0].overlayFlags.map((f) => f.overlay), ['workflows/bug-fix.md']);
  assert.match(formatText(report), /OVERLAY\s+workflows\/bug-fix\.md/);
});

test('localToUpstream reverses rename and respects include/exclude', () => {
  const e = { from: 'skills/*', to: 'dest', rename: { build: 'wing-build' }, exclude: ['shared'], include: undefined };
  assert.equal(localToUpstream(e, 'dest/wing-build/SKILL.md'), 'skills/build/SKILL.md');
  assert.equal(localToUpstream(e, 'elsewhere/x'), null);
  assert.equal(localToUpstream({ from: 'a/b.md', to: 'docs/b.md' }, 'docs/b.md'), 'a/b.md');
  assert.equal(localToUpstream({ from: 'skills/*', to: 'skills', include: ['plan'] }, 'skills/other/x.md'), null);
});

test('readOverlays maps extends to the poteto-mode playbook on the real repo', () => {
  const o = readOverlays();
  assert.ok(o.some((x) => x.overlay === 'workflows/bug-fix.md' && x.target === 'skills/poteto-mode/playbooks/bug-fix.md'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
}
if (failed) { console.error(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`upstream tests ok: ${tests.length}`);
