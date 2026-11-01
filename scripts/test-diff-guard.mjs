#!/usr/bin/env node
// SID-243 (agent writes of scan-affecting diff config) and SID-244 (scan and gate env follow-ups).
// node scripts/test-diff-guard.mjs [guard|variants|scan|gate]... runs those sections; none means all. SID243_FAIL_FAST=1 stops at the first failing case (mutation runs).
// Every repo is a scratch dir with a local bare origin, and every token is built at run time.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from '../hooks/harness/lib.mjs';
import * as rules from '../hooks/harness/guard-rules.mjs';
import { scratch } from './scratch.mjs';
import { COLLATERAL, MUST_ALLOW, MUST_DENY_ATTR, MUST_DENY_CONFIG, MUST_DENY_OPAQUE, MUST_DENY_OVERRIDE, MUST_DENY_WRAPPER, NESTED_QUOTE_VARIANTS, QUOTE_VARIANTS, WRAP_VARIANTS } from './sid243-cases.mjs';

const hooks = new URL('../hooks/harness/', import.meta.url).pathname;
const want = new Set(process.argv.slice(2)), section = (s) => !want.size || want.has(s), failFast = process.env.SID243_FAIL_FAST === '1';
const counts = { pass: 0, fail: 0 }, failed = [];
const t = (name, fn) => {
  try { fn(); counts.pass++; if (process.env.SID243_VERBOSE) console.log(`ok   ${name}`); }
  catch (e) { counts.fail++; failed.push(name); console.log(`FAIL ${name}: ${String(e.message).split('\n')[0].slice(0, 240)}`); if (failFast) process.exit(1); }
};
const sh = (cwd, c, env) => execFileSync('sh', ['-c', c], { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: 'pipe', timeout: 120_000, maxBuffer: 1 << 28 }).toString().trim();
const TOKEN = 'ghp_' + 'A'.repeat(36);
const hook = (d, command, env = {}) => {
  const out = execFileSync('node', [join(hooks, 'pre-bash.mjs')], { cwd: d, env: { ...process.env, ...env }, timeout: 120_000, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: d }) }).toString().trim();
  return out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason ?? '' : '';
};
const cfg = { protectedBranches: ['main', 'master'], allowMerge: false };
const guardWhy = (c, b = 'feat/x') => rules.lineReason(c) ?? rules.segmentReason(c, cfg, b)?.why ?? null;
const repo = (policy = { gate: ['test -f a'] }) => {
  const d = scratch('sid243-');
  sh(d, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init');
  writeFileSync(join(d, '.harness.json'), JSON.stringify(policy));
  sh(d, 'git add .harness.json && git commit -qm policy && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git checkout -q -b feat/x');
  return d;
};
const DRIVER_HELP = /human action/, READ_HELP = /git config --get diff\.external/, ATTR_HELP = /\.gitattributes/;

if (section('guard')) {
  const d = repo();
  const bothBranches = (c, check) => { for (const b of ['feat/x', 'main']) check(guardWhy(c, b), b); };
  const sampled = (list, n) => list.filter((_, k) => k % n === 0);
  for (const c of MUST_DENY_CONFIG) t(`deny config: ${c}`, () => bothBranches(c, (why, b) => { assert.ok(why, `allowed on ${b}`); assert.match(why, DRIVER_HELP); assert.match(why, READ_HELP); }));
  for (const c of MUST_DENY_OVERRIDE) t(`deny override: ${c}`, () => bothBranches(c, (why, b) => { assert.ok(why, `allowed on ${b}`); assert.match(why, DRIVER_HELP); }));
  for (const c of MUST_DENY_OPAQUE) t(`deny opaque: ${JSON.stringify(c)}`, () => bothBranches(c, (why, b) => { assert.ok(why, `allowed on ${b}`); assert.match(why, DRIVER_HELP); }));
  for (const c of MUST_DENY_ATTR) t(`deny attributes: ${c}`, () => bothBranches(c, (why, b) => { assert.ok(why, `allowed on ${b}`); assert.match(why, /(^|[\s"`(])git /.test(c) ? /\.gitattributes|write into \.git\/info/ : ATTR_HELP); }));
  for (const c of MUST_DENY_WRAPPER) t(`deny behind setsid: ${c}`, () => bothBranches(c, (why, b) => assert.ok(why, `allowed on ${b}`)));
  for (const c of COLLATERAL) t(`collateral stays denied: ${c}`, () => bothBranches(c, (why, b) => assert.ok(why, `allowed on ${b}`)));
  for (const c of MUST_ALLOW) t(`allow: ${JSON.stringify(c)}`, () => bothBranches(c, (why, b) => assert.equal(why, null, `denied on ${b}: ${why}`)));
  for (const c of [...sampled(MUST_DENY_CONFIG, 9), ...sampled(MUST_DENY_OVERRIDE, 5), ...MUST_DENY_OPAQUE, ...MUST_DENY_ATTR, ...MUST_DENY_WRAPPER]) t(`deny through the hook: ${JSON.stringify(c)}`, () => assert.ok(hook(d, c), 'allowed'));
  for (const c of MUST_ALLOW) t(`allow through the hook: ${JSON.stringify(c)}`, () => assert.equal(hook(d, c), ''));

  t('end to end: git config diff.external is denied before the push, and the token still is not pushed', () => {
    const e = repo(), silent = join(scratch('sid243-silent-'), 'silent.sh');
    writeFileSync(silent, '#!/bin/sh\nexit 0\n'); chmodSync(silent, 0o755);
    sh(e, `git checkout -q -b leak/e && echo "k=${TOKEN}" > s.txt && git add s.txt && git commit -qm leak`);
    const why = hook(e, `git config diff.external ${silent}`);
    assert.match(why, DRIVER_HELP); assert.match(why, READ_HELP);
    assert.equal(spawnSync('git', ['config', '--get', 'diff.external'], { cwd: e }).status, 1, 'the key was never written');
    assert.match(hook(e, 'git push origin leak/e'), /looks like a secret \(GitHub token\)/);
  });
  t('end to end: each .git/info/attributes write is refused and the repo keeps its attributes empty', () => {
    const e = repo(), f = join(e, '.git', 'info', 'attributes'), before = existsSync(f) ? readFileSync(f, 'utf8') : null;
    for (const c of ["echo '*.txt diff=enc' >> .git/info/attributes", 'tee -a .git/info/attributes < a', 'cp a .git/info/attributes']) assert.match(hook(e, c), ATTR_HELP, c);
    assert.equal(existsSync(f) ? readFileSync(f, 'utf8') : null, before);
  });
  t('a symlink already pointing at .git/info/attributes is a write to it', () => {
    const e = repo(); symlinkSync('.git/info/attributes', join(e, 'al'));
    assert.match(hook(e, 'echo x >> al'), ATTR_HELP); assert.match(hook(e, 'tee -a al < a'), ATTR_HELP); assert.match(hook(e, 'cp a al'), ATTR_HELP);
    assert.equal(hook(e, 'cat al'), '', 'reading through the link is fine');
  });
  t('a symlink at info/attributes of a git dir not named .git is a write to it', () => {
    const e = scratch('sid243-sep-'), gd = join(e, 'gd'), w = join(e, 'w');
    sh(e, `git init -q --separate-git-dir "${gd}" -b main w`);
    symlinkSync(join(gd, 'info', 'attributes'), join(w, 'al'));
    assert.match(hook(w, 'echo x >> al'), ATTR_HELP);
  });
  t('a linked worktree: the common dir attributes file is denied by path', () => {
    const e = repo(), w = join(scratch('sid243-wta-'), 'w'); sh(e, `git worktree add -q "${w}" -b wt`);
    const common = sh(e, 'git rev-parse --absolute-git-dir');
    assert.match(hook(w, `echo x >> ${common}/info/attributes`), ATTR_HELP);
  });
  t('a hardlink to .git/info/attributes is refused', () => {
    const e = repo(); writeFileSync(join(e, '.git', 'info', 'attributes'), ''); sh(e, 'ln .git/info/attributes hl');
    assert.ok(hook(e, 'echo x >> hl'));
  });
  t('reason text: the deny for a config write says what to do instead, on one short line', () => {
    const why = guardWhy('git config diff.external /tmp/x.sh');
    assert.match(why, DRIVER_HELP); assert.match(why, READ_HELP); assert.ok(why.length < 400 && !why.includes('\n'), `${why.length} chars`);
  });
}

if (section('variants')) {
  const d = repo();
  const all = [...WRAP_VARIANTS, ...QUOTE_VARIANTS, ...NESTED_QUOTE_VARIANTS];
  for (const c of all) t(`variant: ${JSON.stringify(c)}`, () => { for (const b of ['feat/x', 'main']) assert.ok(guardWhy(c, b), `allowed on ${b}`); });
  for (const c of all.filter((_, k) => k % 11 === 0)) t(`variant through the hook: ${JSON.stringify(c)}`, () => assert.ok(hook(d, c), 'allowed'));
}

if (section('scan')) {
  const head = (d) => sh(d, 'git rev-parse HEAD'), origin = (d) => sh(d, 'git rev-parse origin/main');
  const clean = (d, f = 'c') => sh(d, `echo ${f} > ${f} && git add ${f} && git commit -qm ${f}`);
  const CLOSED = /could not read the diff for the secret scan \(failing closed\)/, HISTORY = /a commit in the pushed range adds text that looks like a secret \(GitHub token\)/;
  const side = (d, n = 'o1') => sh(d, `git checkout -q -b ${n} && echo ${n} > ${n} && git add ${n} && git commit -qm ${n} && git checkout -q feat/x`);
  // A token added only by a merge, in a -diff file, then removed: only the per-parent read of the merge sees it.
  const mergeOnly = (d, file = 'm.txt') => {
    writeFileSync(join(d, '.gitattributes'), `${file} -diff\n`); sh(d, 'git add .gitattributes && git commit -qm attrs');
    side(d); clean(d);
    sh(d, `git merge -q --no-ff --no-commit o1 && echo "k=${TOKEN}" > ${file} && git add ${file} && git commit -qm evil && git rm -q ${file} && git commit -qm remove`);
  };
  const push = (d, env) => hook(d, 'git push origin feat/x', env);
  const VARS = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];

  t('lock-in: a merge-only token in a -diff file is denied with no pathspec variable set', () => { const d = repo(); mergeOnly(d); assert.match(push(d), HISTORY); });
  for (const v of VARS) t(`${v}=1 in the hook env: a merge-only token in a -diff file is denied`, () => { const d = repo(); mergeOnly(d); assert.match(push(d, { [v]: '1' }), HISTORY); });
  for (const v of VARS) t(`${v}=1 in the hook env: gate commands do not inherit it`, () => { const d = repo({ gate: [`test -z "$${v}"`] }); clean(d); assert.equal(push(d, { [v]: '1' }), ''); });
  t('GIT_ICASE_PATHSPECS=1 cannot widen the *.lock exclude over a token in X.LOCK', () => { const d = repo(); sh(d, `echo "k=${TOKEN}" > X.LOCK && git add X.LOCK && git commit -qm upper`); assert.match(push(d, { GIT_ICASE_PATHSPECS: '1' }), /looks like a secret/); });
  t('GIT_GLOB_PATHSPECS=1 and GIT_NOGLOB_PATHSPECS=1 together do not make the scan fail', () => { const d = repo(); clean(d); assert.equal(push(d, { GIT_GLOB_PATHSPECS: '1', GIT_NOGLOB_PATHSPECS: '1' }), ''); });
  t('lock-in: *.lock in a subdirectory stays excluded under GIT_GLOB_PATHSPECS=1', () => { const d = repo(); sh(d, `mkdir sub && echo "k=${TOKEN}" > sub/x.lock && git add sub && git commit -qm l`); assert.equal(push(d, { GIT_GLOB_PATHSPECS: '1' }), ''); });

  const stderrOf = (fn) => { try { fn(); return ''; } catch (e) { return e.stderr?.toString() ?? ''; } };
  t('the advice flag: a failing scan read prints no hint at all', () => { const d = repo(); const err = stderrOf(() => lib.scanRead(d, ['diff', `${'f'.repeat(40)}..HEAD`])); assert.match(err, /fatal:|bad object/); assert.doesNotMatch(err, /hint:/); });
  t('a scan error names the fatal line, not a hint', () => { const d = repo(); clean(d); const v = lib.pushSecretScan(d, 'f'.repeat(40)); assert.match(v.reason, CLOSED); assert.match(v.reason, /(fatal|error): |bad object/); assert.doesNotMatch(v.reason, /hint:/); assert.doesNotMatch(v.detail, /hint:/); });
  const shimGit = (stderr) => {
    const dir = scratch('sid243-shim-'), real = sh(dir, 'command -v git');
    writeFileSync(join(dir, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in rev-list) printf '%b' '${stderr}' >&2; exit 128;; esac; done\nexec "${real}" "$@"\n`);
    chmodSync(join(dir, 'git'), 0o755);
    return { PATH: `${dir}:${process.env.PATH}` };
  };
  const shimCase = (name, stderr, want, not) => t(name, () => { const d = repo(); clean(d); const why = push(d, shimGit(stderr)); assert.match(why, CLOSED); assert.match(why, want); assert.doesNotMatch(why, not); });
  shimCase('git prints hints first: the reason takes the fatal line', 'hint: Support for grafts\\nhint:\\nfatal: real cause\\n', /: fatal: real cause/, /hint:/);
  shimCase('git prints a warning first: the reason takes the error line', 'warning: noise\\nerror: real cause\\n', /: error: real cause/, /warning: noise/);
  shimCase('a warning before a fatal line: the reason takes the fatal line', 'warning: noise\\nfatal: real cause\\n', /: fatal: real cause/, /warning: noise/);
  shimCase('no fatal or error line: the reason takes the first line that is not a hint', 'hint: a\\nsome real cause\\n', /: some real cause/, /hint:/);
  shimCase('only hints: the reason still fails closed', 'hint: only this\\n', /hint: only this/, /undefined/);

  // Each path is about 100 characters, as in the report: too long for one argv, so a single `git diff` hits E2BIG.
  const hugeMerge = (d, n, withToken) => {
    const blob = sh(d, 'echo x | git hash-object -w --stdin'), dir = 'p'.repeat(60), work = scratch('sid243-huge-');
    const list = join(work, 'list'), env = { GIT_INDEX_FILE: join(work, 'idx') };
    writeFileSync(list, Array.from({ length: n }, (_, i) => `100644 ${blob}\t${dir}/${'q'.repeat(30)}${i}\n`).join(''));
    side(d); clean(d);
    sh(d, `git read-tree HEAD && git update-index --index-info < "${list}"`, env);
    if (withToken) {
      writeFileSync(join(d, '.gitattributes'), 'zz.txt -diff\n');
      const attrs = sh(d, 'git hash-object -w .gitattributes'), tok = sh(d, `echo "k=${TOKEN}" | git hash-object -w --stdin`);
      sh(d, `printf '100644 ${attrs}\\t.gitattributes\\n100644 ${tok}\\tzz.txt\\n' | git update-index --index-info`, env);
    }
    const merge = sh(d, `git commit-tree $(git write-tree) -p HEAD -p o1 -m huge`, env);
    if (!withToken) return void sh(d, `git reset -q --soft ${merge}`);
    sh(d, 'git update-index --force-remove zz.txt', env);
    sh(d, `git reset -q --soft $(git commit-tree $(git write-tree) -p ${merge} -m remove)`, env);
  };
  t('a merge touching 25,000 paths of about 100 characters is scanned: a merge-only token in a -diff file is denied', () => { const d = repo(); hugeMerge(d, 25000, true); assert.match(lib.pushSecretScan(d, origin(d)).reason, /looks like a secret \(GitHub token\)/); });
  t('a merge touching 25,000 paths with no token passes the scan', () => { const d = repo(); hugeMerge(d, 25000, false); assert.equal(lib.pushSecretScan(d, origin(d)), null); });
  t('chunks add up: each chunk fits the limit, but over it in total the scan fails closed and says split', () => {
    const d = repo(); hugeMerge(d, 6000, false); const limit = 1 << 20, reads = [];
    const v = lib.pushSecretScan(d, origin(d), limit, (root, args, o) => {
      const out = lib.scanRead(root, args, { ...o, maxBuffer: 1 << 28 });
      if (o.paths?.some((p) => p.startsWith(':(literal)'))) reads.push(out.length);
      return out;
    });
    assert.ok(reads.length > 2 && reads.every((n) => n < limit), `every chunk under the limit: ${reads}`);
    assert.ok(v, 'not null'); assert.match(v.reason, CLOSED); assert.match(v.reason, /split the push/);
  });
  t('a chunked read of a clean merge just under the limit passes', () => { const d = repo(); hugeMerge(d, 3000, false); assert.equal(lib.pushSecretScan(d, origin(d), 1 << 24), null); });
  const e2big = (d, match) => { const real = lib.scanRead; return lib.pushSecretScan(d, origin(d), 256 << 20, (root, args, o) => { if (match(args, o)) throw Object.assign(new Error('spawnSync git E2BIG'), { code: 'E2BIG' }); return real(root, args, o); }); };
  t('E2BIG on a per-parent read fails closed and says to split the merge', () => { const d = repo(); mergeOnly(d); const v = e2big(d, (a, o) => a[0] === 'diff' && a[1].includes('..') && o.paths?.some((p) => p.startsWith(':(literal)'))); assert.equal(v?.result, 'error'); assert.match(v.reason, CLOSED); assert.match(v.reason, /split the merge/); assert.match(v.detail, /E2BIG/); });
  t('E2BIG anywhere in the scan fails closed with the same hint', () => { const d = repo(); clean(d); const v = e2big(d, (a) => a[0] === 'rev-list'); assert.equal(v?.result, 'error'); assert.match(v.reason, /split the merge/); });
  t('lock-in: other errors do not say to split the merge', () => { const d = repo(); clean(d); const v = lib.pushSecretScan(d, 'f'.repeat(40)); assert.doesNotMatch(v.reason, /split the merge/); });
  t('lock-in: *.lock and *.snap stay excluded from the chunked per-parent reads', () => { const d = repo(); writeFileSync(join(d, '.gitattributes'), '*.lock -diff\n'); sh(d, 'git add .gitattributes && git commit -qm attrs'); side(d); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 && echo "k=${TOKEN}" > m.lock && git add m.lock && git commit -qm evil && git rm -q m.lock && git commit -qm rm`); assert.equal(lib.pushSecretScan(d, origin(d)), null); });
  t('a name with a glob character is read literally, not as a pattern', () => { const d = repo(); writeFileSync(join(d, '.gitattributes'), '*.txt -diff\n'); sh(d, 'git add .gitattributes && git commit -qm attrs'); side(d); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 && echo "k=${TOKEN}" > 'a*[x].txt' && git add 'a*[x].txt' && git commit -qm evil && git rm -q 'a*[x].txt' && git commit -qm rm`); assert.match(lib.pushSecretScan(d, origin(d)).reason, HISTORY); });
}

if (section('gate')) {
  const clean = (d, f = 'c') => sh(d, `echo ${f} > ${f} && git add ${f} && git commit -qm ${f}`);
  const push = (d, env) => hook(d, 'git push origin feat/x', env);
  const originPath = (d) => `${d}.origin.git`;
  const HISTORY = /a commit in the pushed range adds text that looks like a secret \(GitHub token\)/;
  const addRemove = (d) => sh(d, `echo "k=${TOKEN}" > s.txt && git add s.txt && git commit -qm add && git rm -q s.txt && git commit -qm rm`);

  // Nothing here for the walk to differ on, so these overrides can only break things.
  t('a normal repo: gate commands see no shallow override and git says it is not shallow', () => { const d = repo({ gate: ['test -z "$GIT_SHALLOW_FILE"', 'test "$(git rev-parse --is-shallow-repository)" = false'] }); clean(d); assert.equal(push(d), ''); });
  t('a normal repo: gate commands see no graft override and git prints no hint', () => { const d = repo({ gate: ['test -z "$GIT_GRAFT_FILE"', 'test -z "$(git rev-list -1 HEAD 2>&1 >/dev/null)"'] }); clean(d); assert.equal(push(d), ''); });
  t('a normal repo: replace refs stay off for gate commands', () => { const d = repo({ gate: ['test "$GIT_NO_REPLACE_OBJECTS" = 1'] }); clean(d); assert.equal(push(d), ''); });
  t('a normal repo: a gate command can run git clone --depth 1 of a local bare (file://)', () => { const d = repo(), c = join(scratch('sid243-c-'), 'c'); const e = repo({ gate: [`git clone -q --depth 1 "file://${originPath(d)}" "${c}" && test "$(git -C "${c}" rev-parse --is-shallow-repository)" = true`] }); clean(e); assert.equal(push(e), ''); });
  t('a normal repo: a gate command can run git fetch --depth=1 and make a real boundary', () => { const d = repo({ gate: [`git fetch -q --depth=1 origin main && test -f "$(git rev-parse --git-common-dir)/shallow"`] }); clean(d); assert.equal(push(d), ''); });
  t('a normal repo: inherited GIT_SHALLOW_FILE and GIT_GRAFT_FILE do not reach gate commands', () => { const d = repo({ gate: ['test -z "$GIT_SHALLOW_FILE"', 'test -z "$GIT_GRAFT_FILE"'] }); clean(d); assert.equal(push(d, { GIT_SHALLOW_FILE: '/tmp/planted', GIT_GRAFT_FILE: '/tmp/planted' }), ''); });

  const plantBoundary = (d, sha) => writeFileSync(join(d, '.git', 'shallow'), `${sha}\n`);
  t('a shallow file: gate commands keep the override, so a planted boundary hides nothing from them', () => {
    const d = repo({ gate: ['test "$GIT_SHALLOW_FILE" = /dev/null', 'git log --format=%s {base}..HEAD | grep -q below-the-boundary'] });
    sh(d, 'git commit -q --allow-empty -m below-the-boundary'); clean(d); clean(d, 'second');
    plantBoundary(d, sh(d, 'git rev-parse HEAD~1'));
    assert.equal(sh(d, 'git log --format=%s origin/main..HEAD | grep -c below-the-boundary || true'), '0', 'the boundary hides it from a plain walk');
    assert.equal(push(d), '');
  });
  t('a grafts file: gate commands keep the override, so a planted graft hides nothing from them', () => {
    const d = repo({ gate: ['test "$GIT_GRAFT_FILE" = /dev/null', 'git log --format=%s {base}..HEAD | grep -q behind-the-graft'] });
    sh(d, 'git commit -q --allow-empty -m behind-the-graft'); clean(d); clean(d, 'second');
    writeFileSync(join(d, '.git', 'info', 'grafts'), `${sh(d, 'git rev-parse HEAD~1')} ${sh(d, 'git rev-parse origin/main')}\n`);
    assert.equal(push(d), '');
  });
  t('a linked worktree: the shallow file in the common dir keeps the override', () => {
    const d = repo({ gate: ['test "$GIT_SHALLOW_FILE" = /dev/null'] }), w = join(scratch('sid243-wtp-'), 'w');
    sh(d, `git worktree add -q "${w}" -b wt/x`);
    sh(w, 'git config user.email t@t && git config user.name t'); clean(w);
    plantBoundary(d, sh(d, 'git rev-parse origin/main'));
    assert.equal(hook(w, 'git push origin wt/x'), '');
  });
  t('a linked worktree: the grafts file in the common dir keeps the override', () => {
    const d = repo({ gate: ['test "$GIT_GRAFT_FILE" = /dev/null'] }), w = join(scratch('sid243-wtg-'), 'w');
    sh(d, `git worktree add -q "${w}" -b wt/x`);
    sh(w, 'git config user.email t@t && git config user.name t'); clean(w);
    writeFileSync(join(d, '.git', 'info', 'grafts'), '');
    assert.equal(hook(w, 'git push origin wt/x'), '');
  });
  t('a dangling shallow symlink counts as present, so the override stays', () => { const d = repo({ gate: ['test "$GIT_SHALLOW_FILE" = /dev/null'] }); clean(d); symlinkSync('/nonexistent/shallow', join(d, '.git', 'shallow')); assert.equal(push(d), ''); });

  t('the scan ignores a shallow boundary whatever the gate env: a token behind a planted boundary is denied', () => { const d = repo(); addRemove(d); clean(d); plantBoundary(d, sh(d, 'git rev-parse HEAD')); assert.match(push(d), HISTORY); });
  t('a boundary a gate command makes cannot hide a later token from the scan', () => {
    const d = repo({ gate: ['git fetch -q --depth=1 origin main'] }); clean(d); assert.equal(push(d), ''); assert.ok(existsSync(join(d, '.git', 'shallow')), 'the gate made a real boundary');
    addRemove(d); clean(d, 'after'); assert.match(push(d), HISTORY);
  });
  t('gate commands run after the scan: a token fails before any gate command runs', () => { const d = repo({ gate: ['touch gate-ran'] }); addRemove(d); assert.match(push(d), HISTORY); assert.ok(!existsSync(join(d, 'gate-ran')), 'no gate command ran'); });
  t('a later gate command gets the override again once an earlier one made a boundary', () => { const d = repo({ gate: ['git fetch -q --depth=1 origin main', 'test "$GIT_SHALLOW_FILE" = /dev/null'] }); clean(d); assert.equal(push(d), ''); });

  // Pinned collateral: a repo that really has a shallow file keeps the override, so these still fail. Each is in the CHANGELOG's collateral list.
  const reallyShallow = (policy) => {
    const seed = repo(policy), bare = originPath(seed);
    sh(seed, `git checkout -q main && for i in 1 2 3; do echo $i > n$i; git add n$i; git commit -qm n$i; done && git push -q origin main`);
    const c = join(scratch('sid243-sh-'), 'c');
    sh(seed, `git clone -q --depth 2 "file://${bare}" "${c}"`);
    sh(c, 'git config user.email t@t && git config user.name t && git checkout -q -b feat/x');
    sh(c, 'echo c > c && git add c && git commit -qm c');
    assert.equal(sh(c, 'git rev-parse --is-shallow-repository'), 'true');
    return c;
  };
  const failsIn = (gate, msg) => t(`collateral in a really shallow clone: ${gate} fails`, () => { const c = reallyShallow({ gate: [gate] }); assert.match(hook(c, 'git push origin feat/x'), new RegExp(`harness gate failed[^]*${msg}`)); });
  failsIn('git fetch --depth=1 origin main', 'shallow file has changed');
  failsIn('git fetch --deepen=1 origin main', 'shallow file has changed');
  failsIn('git fetch --unshallow origin main', 'shallow file has changed');
  failsIn('git rev-list --count HEAD', 'Failed to traverse parents');
  t('a really shallow clone: the range above the boundary still scans and the shallow view is reported truly', () => { const c = reallyShallow({ gate: ['test "$(git rev-parse --is-shallow-repository)" = true', 'test -z "$(git rev-list -1 HEAD 2>&1 >/dev/null)"'] }); assert.equal(hook(c, 'git push origin feat/x'), ''); });
}

console.log(`\n${counts.pass} passed, ${counts.fail} failed`);
if (counts.fail) { console.log(`failed:\n${failed.map((f) => `  ${f}`).join('\n')}`); process.exit(1); }
