#!/usr/bin/env node
// Offline tests for scripts/upstream.mjs. A stub git runner models a tiny upstream history; one test drives the real script against a
// local bare repo over file:// (real git, no network).
//   node scripts/test-upstream.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  assert.match(report.sources[0].errors[0], /is not on main \(rewritten, or pinned from another branch or PR\)/);
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

test('a key only in vendor.lock.json is its own error entry and its repo is not opened', () => {
  const r = fakeRepo({ commits: [{ sha: A, changes: { 'plugins/pstack/README.md': 'A' } }] });
  const lock = { sources: { ...lockFor(pstackManifest).sources, stale: src('https://github.com/o/stale', B) } };
  const { report, opened } = run(pstackManifest, { 'https://github.com/o/p': r }, { lock });
  assert.deepEqual(opened, ['https://github.com/o/p']);
  assert.equal(report.sources[0].status, 'current');
  const stale = report.sources.find((x) => x.source === 'stale');
  assert.equal(stale.status, 'error');
  assert.deepEqual(stale.errors, ['stale is in vendor.lock.json but not in vendor.manifest.json; run sync']);
  assert.equal(stale.hold, null);
  assert.equal(report.exitCode, 1);
});

test('a licence change upstream counts as relevant drift (default LICENSE and licensePath)', () => {
  const r = fakeRepo({ commits: [
    { sha: A, changes: { 'plugins/pstack/README.md': 'A', LICENSE: 'A', 'legal/LICENSE.txt': 'A' } },
    { sha: B, changes: { LICENSE: 'M' } },
    { sha: C, changes: { 'legal/LICENSE.txt': 'M' } }] });
  const { report } = run(pstackManifest, { 'https://github.com/o/p': r });
  assert.equal(report.sources[0].relevantAhead, 1);
  assert.deepEqual(report.sources[0].changed, [{ status: 'M', path: 'LICENSE' }]);
  const m = manifestFor({ p: { ...src('https://github.com/o/p', A), licensePath: 'legal/LICENSE.txt' } }, pstackManifest.entries);
  assert.deepEqual(run(m, { 'https://github.com/o/p': r }).report.sources[0].changed, [{ status: 'M', path: 'legal/LICENSE.txt' }]);
});

const behindRepo = () => fakeRepo({ commits: [{ sha: A, changes: { 'skills/a/SKILL.md': 'A' } }, { sha: B, changes: { 'skills/a/SKILL.md': 'M' } }] });

test('held: a behind source with a hold reports held, exit 0, and the text shows the reason', () => {
  const m = manifestFor({ s: { ...src('https://github.com/o/s', A), hold: 'SID-43' } }, [{ source: 's', from: 'skills/*', to: 'skills' }]);
  const { report } = run(m, { 'https://github.com/o/s': behindRepo() });
  assert.equal(report.sources[0].status, 'held');
  assert.equal(report.sources[0].hold, 'SID-43');
  assert.deepEqual(report.summary, { current: 0, behind: 0, held: 1, error: 0 });
  assert.equal(report.exitCode, 0);
  const text = formatText(report);
  assert.match(text, /\[HELD\]/);
  assert.match(text, /^  hold      SID-43$/m);
  assert.match(text, /0 current, 0 behind, 1 held, 0 error  \(exit 0\)/);
});

test('json contract: the workflow lists held sources from source + hold, including a held source that is current', () => {
  const all = [{ source: 'b', from: 'skills/*', to: 'skills' }, { source: 'c', from: 'skills/*', to: 'skills' }, { source: 'n', from: 'skills/*', to: 'skills' }];
  const m = manifestFor({ b: { ...src('https://github.com/o/b', A), hold: 'SID-43' }, c: { ...src('https://github.com/o/c', A), hold: 'pinned for legal' }, n: src('https://github.com/o/n', A) }, all);
  const current = fakeRepo({ commits: [{ sha: A, changes: { 'skills/a/SKILL.md': 'A' } }] });
  const { report } = run(m, { 'https://github.com/o/b': behindRepo(), 'https://github.com/o/c': current, 'https://github.com/o/n': current });
  const held = report.sources.filter((s) => s.hold != null).map((s) => `- ${s.source}: ${s.hold}`);
  assert.deepEqual(held, ['- b: SID-43', '- c: pinned for legal']);
  assert.equal(report.exitCode, 0);
  const filter = '.sources[] | select(.hold != null) | "- \\(.source): \\(.hold) [\\(.status)]" + (if .status == "current" then " \\u2014 STALE HOLD: upstream is current; remove the hold" else "" end)';
  const jq = spawnSync('jq', ['-r', filter], { input: JSON.stringify(report), encoding: 'utf8' });
  if (jq.error) console.log('  (jq not installed; skipped the jq filter check)');
  else assert.deepEqual(jq.stdout.trim().split('\n'), ['- b: SID-43 [held]', '- c: pinned for legal [current] \u2014 STALE HOLD: upstream is current; remove the hold']);
});

test('--from-json renders a saved report as text without the network, exit 0', () => {
  const m = manifestFor({ h: { ...src('https://github.com/o/h', A), hold: 'SID-43' } }, [{ source: 'h', from: 'skills/*', to: 'skills' }]);
  const { report } = run(m, { 'https://github.com/o/h': behindRepo() });
  const tmp = mkdtempSync(join(tmpdir(), 'test-from-json-'));
  try {
    const file = join(tmp, 'report.json');
    writeFileSync(file, JSON.stringify(report));
    const script = join(dirname(new URL(import.meta.url).pathname), 'upstream.mjs');
    const r = spawnSync(process.execPath, [script, '--from-json', file], { encoding: 'utf8', env: { ...process.env, SFLOW_UPSTREAM_ROOT: tmp } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd(), formatText(report));
    assert.equal(spawnSync(process.execPath, [script, '--from-json'], { encoding: 'utf8' }).status, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('held plus another behind source is exit 10', () => {
  const m = manifestFor({ h: { ...src('https://github.com/o/h', A), hold: 'SID-43' }, s: src('https://github.com/o/s', A) },
    [{ source: 'h', from: 'skills/*', to: 'skills' }, { source: 's', from: 'skills/*', to: 'skills2' }]);
  const { report } = run(m, { 'https://github.com/o/h': behindRepo(), 'https://github.com/o/s': behindRepo() });
  assert.deepEqual(report.sources.map((x) => x.status), ['held', 'behind']);
  assert.equal(report.exitCode, 10);
});

test('held plus a missing pin is an error, exit 1', () => {
  const m = manifestFor({ h: { ...src('https://github.com/o/h', D), hold: 'SID-43' } }, [{ source: 'h', from: 'skills/*', to: 'skills' }]);
  const { report } = run(m, { 'https://github.com/o/h': behindRepo() });
  assert.equal(report.sources[0].status, 'error');
  assert.equal(report.sources[0].hold, 'SID-43');
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

test('readOverlays reads domains/*/playbooks after workflows, sorted, with repo-relative names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sflow-overlays-'));
  try {
    const put = (rel, body) => { mkdirSync(join(dir, dirname(rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
    put('workflows/bug-fix.md', '---\nextends: bug-fix\n---\n');
    put('domains/zeta/playbooks/spec.md', '---\nextends: spec\n---\n');
    put('domains/alpha/playbooks/setup.md', '---\ntarget: skills/x/SKILL.md\n---\n');
    put('domains/alpha/playbooks/none.md', 'no frontmatter\n');
    put('domains/nopb/README.md', 'x');
    assert.deepEqual(readOverlays(dir), [
      { overlay: 'workflows/bug-fix.md', target: 'skills/poteto-mode/playbooks/bug-fix.md' },
      { overlay: 'domains/alpha/playbooks/setup.md', target: 'skills/x/SKILL.md' },
      { overlay: 'domains/zeta/playbooks/spec.md', target: 'skills/poteto-mode/playbooks/spec.md' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real git, no network: a bare repo over file://, a fake sflow root, and the real main() in a child process.
test('real git: main() over file:// reports behind (exit 10), then current (exit 0) when pinned at head', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sflow-upstream-test-'));
  try {
    const home = join(tmp, 'home'), bare = join(tmp, 'up.git'), work = join(tmp, 'work'), fake = join(tmp, 'root');
    for (const d of [home, work, fake]) mkdirSync(d);
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '--bare', bare);
    git('-C', bare, 'config', 'uploadpack.allowFilter', 'true');
    git('-C', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git('-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git('init', '-q', '-b', 'main', work);
    const commit = (path, body, msg) => {
      mkdirSync(join(work, dirname(path)), { recursive: true });
      writeFileSync(join(work, path), body);
      git('-C', work, 'add', '-A');
      git('-C', work, 'commit', '-q', '-m', msg);
      return git('-C', work, 'rev-parse', 'HEAD');
    };
    const first = commit('skills/a/SKILL.md', 'one\n', 'first');
    commit('docs/unrelated.md', 'x\n', 'unrelated');
    const second = commit('skills/a/SKILL.md', 'two\n', 'touch skills');
    git('-C', work, 'push', '-q', bare, 'main:main');
    git('-C', work, 'checkout', '-q', '-b', 'side', first);
    const side = commit('skills/b/SKILL.md', 'side\n', 'side branch');
    git('-C', work, 'push', '-q', bare, 'side:side');

    const runMain = (pin) => {
      const sources = { s: { repo: `file://${bare}`, sha: pin, license: 'MIT' } };
      writeFileSync(join(fake, 'vendor.manifest.json'), JSON.stringify({ sources, entries: [{ source: 's', from: 'skills/*', to: 'skills' }] }));
      writeFileSync(join(fake, 'vendor.lock.json'), JSON.stringify({ sources }));
      const script = join(dirname(new URL(import.meta.url).pathname), 'upstream.mjs');
      return spawnSync(process.execPath, [script, '--json'], { env: { ...env, SFLOW_UPSTREAM_ROOT: fake }, encoding: 'utf8' });
    };

    const behind = runMain(first);
    assert.equal(behind.status, 10, behind.stderr + behind.stdout);
    const report = JSON.parse(behind.stdout);
    assert.deepEqual(Object.keys(report).sort(), ['exitCode', 'sources', 'summary']);
    const s = report.sources[0];
    assert.deepEqual(Object.keys(s).sort(), ['branch', 'changed', 'compare', 'errors', 'head', 'hold', 'newSkills', 'overlayFlags', 'pinned',
      'relevantAhead', 'removedSkills', 'repo', 'source', 'status', 'totalAhead']);
    assert.equal(s.status, 'behind');
    assert.equal(s.relevantAhead, 1);
    assert.equal(s.totalAhead, 2);
    assert.equal(s.branch, 'main');
    assert.equal(s.head, second);
    assert.deepEqual(s.changed, [{ status: 'M', path: 'skills/a/SKILL.md' }]);

    const current = runMain(second);
    assert.equal(current.status, 0, current.stderr + current.stdout);
    assert.equal(JSON.parse(current.stdout).sources[0].status, 'current');

    // Lazy fetch finds a pin that lives only on another branch, so it fails the ancestor check, not the existence check.
    const offBranch = runMain(side);
    assert.equal(offBranch.status, 1, offBranch.stderr + offBranch.stdout);
    assert.match(JSON.parse(offBranch.stdout).sources[0].errors[0], /is not on main \(rewritten, or pinned from another branch or PR\)/);
    const missing = runMain('0123456789abcdef0123456789abcdef01234567');
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).sources[0].errors[0], /no longer exists upstream/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
}
if (failed) { console.error(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`upstream tests ok: ${tests.length}`);
