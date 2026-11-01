#!/usr/bin/env node
// Tests for the git hooks outside Claude (SID-147): scripts/hooks.mjs install|check and hooks/harness/git-hook.mjs.
// Plain node and git against temp repos with a local bare origin; nothing touches this checkout's own git config.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPATCHER, ORIGIN_OK, source, sourceProblem, STABLE_CLONE, stub } from './hooks.mjs';
import { scratch } from './scratch.mjs';
import { guardVerdict, pushCommand } from '../hooks/harness/git-hook.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hooksCli = join(here, 'hooks.mjs');
const preBash = join(here, '..', 'hooks', 'harness', 'pre-bash.mjs');
const tmp = realpathSync(scratch('sflow-test-git-hooks-')); // removed on every exit path (scripts/scratch.mjs, SID-55)
// A clean environment for git: no inherited GIT_* (the tests may run inside a git hook), a private HOME, no system or global config.
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, c, env = {}) => spawnSync('sh', ['-c', c], { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
const ok = (cwd, c, env) => { const r = sh(cwd, c, env); assert.equal(r.status, 0, `${c}\n${r.stdout}${r.stderr}`); return r.stdout.trim(); };
const cli = (...args) => spawnSync(process.execPath, [hooksCli, ...args], { env: ENV, encoding: 'utf8' });
const secret = () => `AKIA${'Q'.repeat(16)}`; // built at run time, so this file holds no secret-shaped text
let n = 0;
// A repo whose origin (a local bare repo) has main, optionally with a committed .harness.json; feat/x checked out.
function repo(policy = { gate: ['test -f a'] }) {
  const d = join(tmp, `r${++n}`); mkdirSync(d);
  ok(d, 'git init -q -b main && echo a > a && git add a && git commit -qm init');
  if (policy) { writeFileSync(join(d, '.harness.json'), JSON.stringify(policy)); ok(d, 'git add .harness.json && git commit -qm policy'); }
  ok(d, `git clone -q --bare . ../r${n}.origin.git && git remote add origin ../r${n}.origin.git && git fetch -q origin && git checkout -q -b feat/x`);
  return d;
}
const claudeDenies = (d, command) => {
  const out = execFileSync(process.execPath, [preBash], { cwd: d, env: ENV, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: d }) }).toString().trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny' : false;
};
const remoteSha = (d, ref) => sh(d, `git ls-remote origin ${ref}`).stdout.split(/\s/)[0] || null;
const t = (name, fn) => { fn(); console.log(`ok   ${name}`); };

t('k1: check reports a repo without the hooks, and names the human install command', () => {
  const d = repo();
  const r = cli('check', '--repo', d);
  assert.equal(r.status, 1); assert.match(r.stdout, /NOT INSTALLED .*core\.hooksPath is unset; a human runs: npm run hooks -- install --repo/);
  assert.equal(cli('check', '--repo', join(tmp, 'nowhere')).status, 1);
  assert.equal(cli('frobnicate').status, 2); assert.equal(cli('check', '--force').status, 2);
});

t('k2: install sets core.hooksPath to executable stubs in the common git dir, and is idempotent', () => {
  const d = repo();
  const r = cli('install', '--repo', d); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^installed /);
  const dir = join(d, '.git', 'sflow-hooks');
  assert.equal(ok(d, 'git config --get core.hooksPath'), dir);
  for (const h of ['pre-commit', 'pre-push']) {
    assert.ok(statSync(join(dir, h)).mode & 0o111, `${h} is executable`);
    assert.equal(readFileSync(join(dir, h), 'utf8'), stub(h));
    assert.match(stub(h), new RegExp(`exec node "\\$D" ${h} "\\$@"`));
  }
  assert.ok(existsSync(DISPATCHER), 'the dispatcher the stubs call is built into hooks/harness/');
  const before = statSync(join(dir, 'pre-push')).mtimeMs;
  const again = cli('install', '--repo', d); assert.equal(again.status, 0); assert.match(again.stdout, /^current /);
  assert.equal(statSync(join(dir, 'pre-push')).mtimeMs, before, 'a second install rewrites nothing');
  assert.ok(!existsSync(join(dir, 'previous-hooks-path')), 'nothing to save when core.hooksPath was unset');
  assert.match(cli('check', '--repo', d).stdout, /^ok .*pre-commit, pre-push/);
  writeFileSync(join(dir, 'pre-push'), '#!/bin/sh\nexit 0\n');
  const stale = cli('check', '--repo', d); assert.equal(stale.status, 1); assert.match(stale.stdout, /pre-push: stub is stale or edited/);
  chmodSync(join(dir, 'pre-commit'), 0o644);
  assert.match(cli('check', '--repo', d).stdout, /pre-commit: stub not executable/);
  assert.equal(cli('install', '--repo', d).status, 0); assert.equal(cli('check', '--repo', d).status, 0, 'install repairs');
});

t('k3: existing .git/hooks keep running first (pre-commit, pre-push and other names), and their failure fails the hook', () => {
  const d = repo();
  const hk = join(d, '.git', 'hooks');
  writeFileSync(join(hk, 'pre-commit'), '#!/bin/sh\necho ran >> "$(git rev-parse --git-dir)/own-pre-commit"\nexit ${OWN_FAIL:-0}\n'); chmodSync(join(hk, 'pre-commit'), 0o755);
  writeFileSync(join(hk, 'commit-msg'), '#!/bin/sh\ngrep -q ok "$1"\n'); chmodSync(join(hk, 'commit-msg'), 0o755);
  writeFileSync(join(hk, 'pre-push'), '#!/bin/sh\ncat > "$(git rev-parse --git-dir)/own-pre-push"\n'); chmodSync(join(hk, 'pre-push'), 0o755);
  assert.equal(cli('install', '--repo', d).status, 0);
  assert.ok(existsSync(join(d, '.git', 'sflow-hooks', 'commit-msg')), 'a stub for every existing hook, so moving core.hooksPath turns none off');
  ok(d, 'echo b > b && git add b && git commit -qm ok');
  assert.equal(readFileSync(join(d, '.git', 'own-pre-commit'), 'utf8'), 'ran\n');
  assert.notEqual(sh(d, 'echo c > c && git add c && git commit -qm nope').status, 0, 'the chained commit-msg hook still rejects');
  assert.notEqual(sh(d, 'git commit -qm ok', { OWN_FAIL: '3' }).status, 0, 'a failing repo pre-commit fails the commit');
  ok(d, 'git commit -qm ok && git push -q origin feat/x');
  assert.match(readFileSync(join(d, '.git', 'own-pre-push'), 'utf8'), /^refs\/heads\/feat\/x [0-9a-f]{40} refs\/heads\/feat\/x 0{40}/, 'the repo pre-push gets git\'s stdin');
});

t('k4: a previous core.hooksPath (husky style) is saved, still runs first, and is never looped onto the stubs', () => {
  const d = repo();
  mkdirSync(join(d, 'hk')); writeFileSync(join(d, 'hk', 'pre-push'), '#!/bin/sh\necho husky-ran >&2\nexit ${HK_FAIL:-0}\n'); chmodSync(join(d, 'hk', 'pre-push'), 0o755);
  ok(d, 'git config core.hooksPath hk');
  const r = cli('install', '--repo', d); assert.equal(r.status, 0); assert.match(r.stdout, /saved .*previous core\.hooksPath hk/);
  const saved = join(d, '.git', 'sflow-hooks', 'previous-hooks-path');
  assert.equal(readFileSync(saved, 'utf8'), `${join(d, 'hk')}\n`, 'saved as an absolute path in the stub dir, not in git config');
  assert.equal(sh(d, 'git config --get sflow.previousHooksPath').status, 1);
  assert.equal(cli('install', '--repo', d).status, 0); assert.equal(readFileSync(saved, 'utf8'), `${join(d, 'hk')}\n`, 'a rerun keeps the saved path');
  const p = sh(d, 'echo b > b && git add b && git commit -qm b && git push origin feat/x');
  assert.equal(p.status, 0, p.stderr); assert.match(p.stderr, /husky-ran/); assert.match(p.stderr, /sflow gate ok [0-9a-f]{12}/);
  ok(d, 'echo c > c && git add c && git commit -qm c');
  assert.notEqual(sh(d, 'git push origin feat/x', { HK_FAIL: '1' }).status, 0, 'a failing previous hook fails the push');
});

t('k5: parity: the git pre-push hook gives the Claude guard\'s verdict for the same ref update, and the refused update never reaches origin', () => {
  const d = repo();
  assert.equal(cli('install', '--repo', d).status, 0);
  ok(d, 'echo b > b && git add b && git commit -qm b');
  const cases = [];
  const push = (label, ref, human, claude, setup) => {
    if (setup) ok(d, setup);
    const deny = claudeDenies(d, claude);
    const was = remoteSha(d, ref);
    const r = sh(d, human);
    cases.push(label);
    assert.equal(r.status !== 0, deny, `${label}: Claude ${deny ? 'denies' : 'allows'} \`${claude}\`, git hook ${r.status ? 'refused' : 'allowed'} \`${human}\`\n${r.stderr}`);
    if (deny) assert.equal(remoteSha(d, ref), was, `${label}: origin unchanged`); else assert.match(r.stderr, /sflow gate ok [0-9a-f]{12}/);
    return r;
  };
  push('feature push', 'feat/x', 'git push origin feat/x', 'git push origin feat/x');
  push('protected branch', 'main', 'git push origin feat/x:main', 'git push origin feat/x:main');
  push('protected via HEAD', 'master', 'git push origin HEAD:master', 'git push origin HEAD:master');
  push('local main', 'main', 'git checkout -q main && git merge -q --ff-only feat/x && git push origin main; s=$?; git checkout -q feat/x; exit $s', 'git push origin main');
  push('force (non-fast-forward)', 'feat/x', 'git push --force origin feat/x', 'git push --force origin feat/x', 'git commit -q --amend -m b2');
  push('+refspec', 'feat/x', 'git push origin +feat/x', 'git push origin +feat/x');
  push('delete protected', 'main', 'git push origin --delete main', 'git push origin --delete main');
  ok(d, 'git reset -q --hard origin/feat/x');
  push('second feature push to a new name', 'feat/y', 'git push origin feat/x:feat/y', 'git push origin feat/x:feat/y', 'echo c > c && git add c && git commit -qm c');
  assert.ok(cases.length >= 8);
  // The judged command a human push maps to, for each kind of update.
  const z = '0'.repeat(40), h = ok(d, 'git rev-parse HEAD'), p = ok(d, 'git rev-parse HEAD~1');
  assert.equal(pushCommand(d, 'origin', ['refs/heads/feat/x', h, 'refs/heads/feat/x', z]), 'git push origin feat/x:feat/x');
  assert.equal(pushCommand(d, 'origin', ['refs/heads/feat/x', h, 'refs/heads/feat/x', p]), 'git push origin feat/x:feat/x');
  assert.equal(pushCommand(d, 'origin', ['refs/heads/feat/x', p, 'refs/heads/feat/x', h]), 'git push --force origin feat/x:feat/x', 'remote ahead: non-fast-forward');
  assert.equal(pushCommand(d, 'origin', ['refs/heads/feat/x', h, 'refs/heads/feat/x', 'f'.repeat(40)]), 'git push --force origin feat/x:feat/x', 'unknown remote commit: treated as force');
  assert.equal(pushCommand(d, 'origin', ['(delete)', z, 'refs/heads/main', h]), 'git push origin --delete main');
  assert.equal(pushCommand(d, 'origin', ['HEAD', h, 'refs/heads/main', z]), `git push origin ${h}:main`);
});

t('k6: the gate runs at push: a failing gate or a committed secret refuses; a push of a commit other than HEAD is refused while a gate is in force', () => {
  const g = repo({ gate: ['false'] });
  assert.equal(cli('install', '--repo', g).status, 0);
  ok(g, 'echo b > b && git add b && git commit -qm b');
  const f = sh(g, 'git push origin feat/x'); assert.notEqual(f.status, 0); assert.match(f.stderr, /harness gate failed: `false`/); assert.equal(remoteSha(g, 'feat/x'), null);
  assert.equal(claudeDenies(g, 'git push origin feat/x'), true, 'parity');
  const s = repo();
  assert.equal(cli('install', '--repo', s).status, 0);
  writeFileSync(join(s, 'cfg.txt'), `key=${secret()}\n`);
  ok(s, 'git add cfg.txt && git -c core.hooksPath=/dev/null commit -qm leak'); // a commit made around the hooks still meets the push scan
  const p = sh(s, 'git push origin feat/x'); assert.notEqual(p.status, 0); assert.match(p.stderr, /looks like a secret \(AWS key\)/); assert.equal(remoteSha(s, 'feat/x'), null);
  const o = repo();
  assert.equal(cli('install', '--repo', o).status, 0);
  ok(o, 'git branch other && echo b > b && git add b && git commit -qm b');
  ok(o, 'git checkout -q other && echo c > c && git add c && git commit -qm c && git checkout -q feat/x');
  const r = sh(o, 'git push origin other'); assert.notEqual(r.status, 0); assert.match(r.stderr, /the gate checks HEAD/);
  for (const c of ['git push origin feat/x other', 'git push --all origin']) { // README: multi-branch pushes and --all are refused while a gate is in force
    const m = sh(o, c); assert.notEqual(m.status, 0, c); assert.match(m.stderr, /the gate checks HEAD/, c); assert.equal(remoteSha(o, 'other'), null, c);
  }
});

t('k7: no policy on origin: pushes go through with "sflow gate skipped: <reason>"; the guard still refuses protected pushes', () => {
  const d = repo(null);
  assert.equal(cli('install', '--repo', d).status, 0);
  ok(d, 'echo b > b && git add b && git commit -qm b');
  const r = sh(d, 'git push origin feat/x'); assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /sflow gate skipped: no \.harness\.json committed on origin/);
  assert.notEqual(sh(d, 'git push origin feat/x:main').status, 0);
  const e = repo({ gate: [] }); assert.equal(cli('install', '--repo', e).status, 0);
  ok(e, 'echo b > b && git add b && git commit -qm b');
  assert.match(sh(e, 'git push origin feat/x').stderr, /sflow gate skipped: the gate in origin\/main is empty/);
});

t('k8: pre-commit refuses staged secrets, also through git commit -a and git commit <path> (temporary index)', () => {
  const d = repo();
  assert.equal(cli('install', '--repo', d).status, 0);
  writeFileSync(join(d, 'cfg.txt'), `key=${secret()}\n`);
  const r = sh(d, 'git add cfg.txt && git commit -qm leak'); assert.notEqual(r.status, 0); assert.match(r.stderr, /staged text looks like a secret \(AWS key\)/);
  ok(d, 'git reset -q && rm cfg.txt && echo x >> a && git commit -qam clean');
  writeFileSync(join(d, 'a'), `x=${secret()}\n`);
  assert.notEqual(sh(d, 'git commit -qam leak').status, 0, 'commit -a');
  assert.notEqual(sh(d, 'git commit -qm leak a').status, 0, 'commit <path>');
  assert.equal(ok(d, 'git log -1 --format=%s'), 'clean');
});

t('k9: no environment variable bypasses the hooks', () => {
  const d = repo();
  assert.equal(cli('install', '--repo', d).status, 0);
  ok(d, 'echo b > b && git add b && git commit -qm b');
  const bypass = { HUSKY: '0', SKIP: 'all', SKIP_HOOKS: '1', LEFTHOOK: '0', PRE_COMMIT_ALLOW_NO_CONFIG: '1', SFLOW_SKIP_HOOKS: '1', SFLOW_HOOKS: '0', HARNESS_SKIP: '1', HARNESS_GATE: '0', NO_VERIFY: '1', CLAUDE_PLUGIN_ROOT: '/nonexistent', CLAUDE_CONFIG_DIR: tmp, CI: '1', GIT_NO_REPLACE_OBJECTS: '0', NODE_OPTIONS: '' };
  assert.notEqual(sh(d, 'git push origin feat/x:main', bypass).status, 0, 'protected push still refused');
  writeFileSync(join(d, 'cfg.txt'), `key=${secret()}\n`);
  assert.notEqual(sh(d, 'git add cfg.txt && git commit -qm leak', bypass).status, 0, 'staged secret still refused');
  ok(d, 'git reset -q && rm cfg.txt');
  assert.notEqual(sh(d, 'git push origin feat/x:main', { GIT_INDEX_FILE: join(tmp, 'nope'), GIT_DIR: join(d, '.git') }).status, 0, 'GIT_* env from the caller changes nothing');
});

t('k10: the stubs fail closed when the dispatcher is gone; hooks cover linked worktrees', () => {
  const d = repo();
  assert.equal(cli('install', '--repo', d).status, 0);
  writeFileSync(join(d, '.git', 'sflow-hooks', 'pre-commit'), stub('pre-commit', join(tmp, 'moved', 'git-hook.mjs')));
  const r = sh(d, 'echo b > b && git add b && git commit -qm b'); assert.notEqual(r.status, 0); assert.match(r.stderr, /is missing; rerun `npm run hooks -- install`/);
  assert.equal(cli('check', '--repo', d).status, 1);
  assert.equal(cli('install', '--repo', d).status, 0);
  ok(d, `git worktree add -q -b feat/wt ../wt${n}`);
  const wt = join(tmp, `wt${n}`);
  assert.match(cli('check', '--repo', wt).stdout, /^ok /, 'a linked worktree shares the common git dir');
  ok(wt, 'echo w > w && git add w && git commit -qm w');
  assert.notEqual(sh(wt, 'git push origin feat/wt:main').status, 0, 'protected push from a linked worktree refused');
  const w = sh(wt, 'git push origin feat/wt'); assert.equal(w.status, 0, w.stderr); assert.match(w.stderr, /sflow gate ok/);
});

t('k11: sflow runs the guard and gate without the caller\'s GIT_* env, and fails closed if the guard crashes or prints garbage', () => {
  const d = repo({ gate: [`node -e "process.exit(Object.keys(process.env).some((k) => /^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) ? 1 : 0)"`] });
  assert.equal(cli('install', '--repo', d).status, 0);
  ok(d, 'echo b > b && git add b && git commit -qm b');
  const r = sh(d, 'git push origin feat/x', { GIT_INDEX_FILE: join(d, '.git', 'index'), GIT_WORK_TREE: d, GIT_DIR: join(d, '.git') });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /sflow gate ok/);
  for (const [body, want] of [['process.exit(2)', /the guard exited 2 \(failing closed\)/], ['console.log("not json")', /unreadable guard output \(failing closed\)/], ['throw new Error("x")', /the guard exited 1/]]) {
    const f = join(tmp, `crash${body.length}.mjs`); writeFileSync(f, body);
    assert.match(guardVerdict(d, 'git status', f) ?? 'allowed', want);
  }
  assert.equal(guardVerdict(d, 'git status'), null); assert.match(guardVerdict(d, 'git push origin main'), /protected/);
});

t('k12: the chained hooks dir can\'t be redirected by an agent: git config is ignored, the guard denies the routes, and a saved path outside the repo fails closed', () => {
  const evil = join(tmp, 'evil'); mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, 'pre-commit'), '#!/bin/sh\necho EVIL-RAN >&2\n'); chmodSync(join(evil, 'pre-commit'), 0o755);
  const d = repo();
  assert.equal(cli('install', '--repo', d).status, 0);
  for (const c of ['git config sflow.previousHooksPath ' + evil, 'git config --remove-section core', 'git config --edit', 'git config --unset-all core.hookspath',
    `printf '${evil}\\n' > .git/sflow-hooks/previous-hooks-path`, `echo ${evil} > .git/sflow-hooks/previous-hooks-path`, 'rm .git/sflow-hooks/previous-hooks-path'])
    assert.equal(claudeDenies(d, c), true, `the Claude guard denies: ${c}`);
  ok(d, `git config sflow.previousHooksPath ${evil}`); // as if typed around the guard: the hook never reads it
  const r = sh(d, 'echo b > b && git add b && git commit -qm b'); assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stderr, /EVIL-RAN/);
  const saved = join(d, '.git', 'sflow-hooks', 'previous-hooks-path');
  for (const [text, want] of [[`${evil}\n`, /outside the git dir and the working tree/], ['hk\n', /holds a relative path/], [`${join(d, '.git', 'sflow-hooks')}\n`, /sflow's own stub dir/]]) {
    writeFileSync(saved, text);
    const f = sh(d, `echo ${text.length} >> b && git add b && git commit -qm x`); assert.notEqual(f.status, 0, text); assert.match(f.stderr, want); assert.doesNotMatch(f.stderr, /EVIL-RAN/);
    assert.equal(cli('check', '--repo', d).status, 1, `check reports the bad saved path: ${text}`);
  }
  symlinkSync(evil, join(d, 'lnk')); writeFileSync(saved, `${join(d, 'lnk')}\n`); // inside the working tree by name, outside once resolved
  const l = sh(d, 'echo l >> b && git add b && git commit -qm l'); assert.notEqual(l.status, 0); assert.match(l.stderr, /outside the git dir and the working tree/); assert.doesNotMatch(l.stderr, /EVIL-RAN/);
  ok(d, `rm lnk ${saved}`); assert.equal(cli('check', '--repo', d).status, 0, 'no saved path: back to .git/hooks');
  const o = repo(); ok(o, `git config core.hooksPath ${evil}`);
  const i = cli('install', '--repo', o); assert.equal(i.status, 1); assert.match(i.stdout, /REFUSED .*can't be chained/);
  assert.equal(ok(o, 'git config --get core.hooksPath'), evil, 'a refused install changes nothing'); assert.ok(!existsSync(join(o, '.git', 'sflow-hooks')));
  const g = repo(); assert.equal(cli('install', '--repo', g).status, 0);
  ok(g, 'git config --remove-section core'); // as a human could: check says so, and a fresh install repairs it
  assert.match(cli('check', '--repo', g).stdout, /NOT INSTALLED/);
});

t('k13: `source` keeps the stable clone on merged main: ff-only, refuses dirty/branch/origin, --check is read-only', () => {
  assert.equal(STABLE_CLONE, join(process.env.HOME, '.local', 'share', 'sflow'));
  for (const u of ['https://github.com/siddhant-angore/sflow.git', 'https://github.com/siddhant-angore/sflow', 'git@github.com:siddhant-angore/sflow.git', 'ssh://git@github.com/siddhant-angore/sflow.git']) assert.ok(ORIGIN_OK(u), u);
  for (const u of ['https://github.com/someone/sflow.git', 'https://github.com/siddhant-angore/sflow-fork.git', 'https://evil.com/siddhant-angore/sflow.git', 'https://github.com.evil.com/siddhant-angore/sflow.git', '/tmp/x.git', '../r1.origin.git', 'https://github.com/siddhant-angore/sflow.git.evil'])
    assert.ok(!ORIGIN_OK(u), u);
  const up = repo(null), originDir = join(up, '..', `r${n}.origin.git`);
  const local = (u) => u === originDir || u === realpathSync(originDir); // tests only: a local bare origin stands in for github
  const clone = join(tmp, `clone${n}`); ok(tmp, `git clone -q ${originDir} ${clone}`);
  const lines = []; const run = (o = {}) => { lines.length = 0; return source(clone, { log: (l) => lines.push(l), originOk: local, ...o }); };
  const head = () => ok(clone, 'git rev-parse HEAD'), main = () => ok(up, 'git rev-parse origin/main');
  assert.equal(run({ checkOnly: true }), true); assert.match(lines[0], /^ok .* is on origin main/);
  assert.equal(run(), true); assert.match(lines[0], /^current /);
  const old = head(); ok(up, 'git checkout -q main && echo 2 > two && git add two && git commit -qm two && git push -q origin main && git fetch -q origin && git checkout -q feat/x');
  assert.equal(run({ checkOnly: true }), false); assert.match(lines[0], /^BEHIND .* a human runs: npm run hooks -- source/);
  assert.equal(head(), old, '--check changes nothing'); assert.notEqual(ok(clone, 'git rev-parse origin/main'), main(), '--check does not fetch');
  assert.equal(run(), true); assert.equal(lines[0], `updated   ${realpathSync(clone)} ${old} -> ${main()}`); assert.equal(head(), main());
  assert.equal(run({ checkOnly: true }), true);
  // refusals change nothing
  const refused = (setup, undo, want) => {
    ok(up, 'git checkout -q main && echo $RANDOM >> two && git commit -qam more && git push -q origin main && git checkout -q feat/x');
    const before = head(); ok(clone, setup);
    for (const checkOnly of [true, false]) { assert.equal(run({ checkOnly }), false, setup); assert.match(lines[0], want); assert.match(lines[0], /nothing changed/); }
    assert.equal(head(), before, `refused: ${setup}`); ok(clone, undo);
  };
  refused('echo x >> two', 'git checkout -q -- two', /^REFUSED .*not clean/);
  refused('echo x > untracked', 'rm untracked', /^REFUSED .*not clean/);
  refused('echo x > staged && git add staged', 'git rm -q --cached staged && rm staged', /^REFUSED .*not clean/);
  refused('git checkout -q -b other', 'git checkout -q main', /^REFUSED .*on other, not main/);
  refused('git checkout -q --detach', 'git checkout -q main', /^REFUSED .*detached HEAD, not main/);
  refused(`git config url.${originDir}.insteadOf /nowhere/x.git && git remote set-url origin /nowhere/x.git`, `git config --remove-section url.${originDir} && git remote set-url origin ${originDir}`, /^REFUSED .*origin is \/nowhere\/x\.git/);
  refused(`git config url./nowhere/evil.git.insteadOf ${originDir}`, 'git config --remove-section url./nowhere/evil.git', /^REFUSED .*-> \/nowhere\/evil\.git/); // insteadOf can't redirect it
  assert.equal(run(), true); assert.equal(head(), main());
  // the real origin check: a local origin is refused by the CLI default
  assert.match(sourceProblem(clone), /not github\.com\/siddhant-angore\/sflow/);
  const c = cli('source', '--check', '--clone', clone); assert.equal(c.status, 1); assert.match(c.stdout, /REFUSED/);
  assert.equal(cli('source', '--bogus').status, 2);
  assert.match(sourceProblem(join(clone, 'skills') + '-none'), /not the top of a git checkout/);
  // ff-only: a clone with its own commit is never merged or reset
  ok(clone, 'echo mine > mine && git add mine && git commit -qm mine');
  const mine = head(); ok(up, 'git checkout -q main && echo 3 >> two && git commit -qam three && git push -q origin main && git checkout -q feat/x');
  assert.equal(run({ checkOnly: true }), false); assert.match(lines[0], /^BEHIND /);
  assert.equal(run(), false); assert.match(lines[0], /^FAILED .*still at /); assert.equal(head(), mine, 'diverged: nothing merged');
  ok(up, 'git fetch -q origin'); ok(clone, `git fetch -q origin && git reset -q --hard origin/main`); // test cleanup only
  ok(clone, 'echo ahead > ahead && git add ahead && git commit -qm ahead');
  assert.equal(run({ checkOnly: true }), false); assert.match(lines[0], /^AHEAD .* has commits main does not/);
});

console.log('git hooks tests ok');
