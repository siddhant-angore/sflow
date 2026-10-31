// Pipes sample events through each hook and asserts the decision. Run: node scripts/test-hooks.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = new URL('../hooks/harness/', import.meta.url).pathname;
const run = (hook, ev) => {
  const out = execFileSync('node', [join(hooks, hook)], { input: JSON.stringify(ev), cwd: ev.cwd }).toString().trim();
  return out ? JSON.parse(out) : null;
};
const sh = (cwd, c) => execFileSync('sh', ['-c', c], { cwd, stdio: 'pipe' }).toString().trim();
const reasonOf = (r) => r?.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (hook, ev) => run(hook, ev)?.hookSpecificOutput?.permissionDecision === 'deny';

// A repo with an origin whose main carries the policy, and a feature branch checked out.
const repo = mkdtempSync(join(tmpdir(), 'harness-test-'));
sh(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init');
writeFileSync(join(repo, '.harness.json'), JSON.stringify({ gate: ['test -f a', 'echo base={base}'] }));
sh(repo, 'git add .harness.json && git commit -qm policy && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git checkout -q -b feat/x');
const bash = (command, cwd = repo) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

const mustDeny = [
  'git push --force origin feat/x', 'git push -f', 'git push -fu origin feat/x', 'git push -uf origin feat/x', 'git push --force-with-lease origin main',
  'git push origin main', 'git push origin HEAD:main', 'git push origin +feat/x', 'git push origin +main', 'git -C . push --force origin feat/x',
  'git -c x=y push -f', 'git --no-pager push origin main', 'cd sub && git push -f origin feat/x', 'echo hi && git push -f', 'B=main; git push origin $B',
  'git push origin `cat b`', 'git push --mirror', 'git push origin --delete feat/x', 'git push origin :feat/x', 'git push --tags', 'git push origin main --no-verify',
  'git reset --hard HEAD~1', 'git reset HEAD~1 --hard', 'git reset -q --hard', 'git reset --merge', 'git checkout .', 'git checkout -- .', 'git restore .', 'git restore --worktree .',
  'git switch --discard-changes main', 'git checkout -f main', 'git clean -fd', 'git clean -xdf', 'git branch -D x', 'git branch -df x', 'git branch -d -f x', 'git branch --delete --force x',
  'git stash clear', 'git stash drop', 'git commit --no-verify -m x', 'git commit -n -m x', 'git merge --no-verify feat', 'git -c core.hooksPath=/dev/null commit -m x', 'HUSKY=0 git commit -m x',
  'git filter-branch --all', 'git update-ref -d refs/heads/x', 'gh pr merge 1', 'gh pr merge 1 --auto', 'gh pr close 1', 'gh api -X PUT repos/o/r/pulls/1/merge', 'gh api --method DELETE repos/o/r',
  'gh api repos/o/r/issues -f title=x', 'gh release create v1', 'gh repo delete o/r', 'npm publish', 'pnpm publish --access public', 'git merge feat && git push origin main',
  'git update-ref refs/replace/abc def', 'git update-ref -d refs/replace/abc', 'git replace abc def', 'git replace -f abc def', 'git replace -d abc', 'git replace --graft abc', 'git replace --edit abc',
  'echo "update refs/replace/abc def" | git update-ref --stdin', "printf 'update refs/remotes/origin/main abc\\n' | git update-ref --stdin",
  'git symbolic-ref HEAD refs/remotes/origin/main', 'git symbolic-ref -m x HEAD refs/remotes/origin/main', 'git symbolic-ref -m "x y" HEAD refs/remotes/origin/main', 'git symbolic-ref HEAD refs/tags/v1', 'git symbolic-ref HEAD refs/replace/abc',
  // SID-65: repo-discovery config, pushes into this repo, fast-import, update-ref --stdin
  'git config core.bare true', 'git config --local core.bare true', 'git config --global include.path /tmp/x', 'git config set core.repositoryformatversion 9', 'git config --file .git/config core.worktree /tmp', 'git config --unset core.bare',
  'git config includeIf.gitdir:/x/.path /tmp/x', 'git -c core.bare=true status', 'git -c include.path=/tmp/x fetch', 'git -c core.bare status', "git -c 'core.bare' status", 'git --config-env=core.bare=X status',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=true git status', "GIT_CONFIG_PARAMETERS=\"'core.bare'='true'\" git status",
  'git push . HEAD:refs/remotes/origin/main', 'git push . evil:main', 'git push ./ x:y', 'git push origin HEAD:refs/remotes/origin/main', 'git push origin x:refs/replace/abc',
  'FOO=1 git push --force origin feat/x', 'A="x y" git push origin main', 'env FOO=1 git push -f',
  'git fast-import', 'git fast-import --force < dump', 'echo "update refs/heads/tmp HEAD" | git update-ref --stdin', 'git update-ref --stdin < f', 'git update-ref -z --stdin',
];
for (const c of mustDeny) assert.ok(denied('pre-bash.mjs', bash(c)), `must deny: ${c}`);

const allowRemote = [
  'git fetch', 'git fetch origin', 'git fetch origin main', 'git fetch origin feat/x', 'git fetch --prune', 'git fetch -p origin', 'git fetch --all', 'git fetch --all --prune', 'git fetch origin main:main', 'git fetch origin refs/heads/main:refs/heads/tmp', 'git pull', 'git pull --rebase', 'git pull origin main', 'git pull --ff-only', 'git remote set-head origin --auto', 'git remote set-head origin -a', 'git remote -v', 'git remote show origin', 'git symbolic-ref refs/remotes/origin/HEAD', 'git symbolic-ref --short refs/remotes/origin/HEAD', 'git symbolic-ref HEAD', 'git update-ref refs/heads/tmp HEAD', 'git config --get remote.origin.fetch', 'git config --get-all remote.origin.fetch', 'git config remote.origin.fetch', 'git config -l', 'git config --list', 'git config user.name x', 'git -c color.ui=never fetch origin', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=never git fetch', "GIT_CONFIG_PARAMETERS=\"'color.ui'='never'\" git fetch", 'gh repo view', 'gh repo view --json defaultBranchRef', 'gh repo view o/r --json name',
];
const mustAllow = [
  'git push -u origin feat/x', 'git push', 'git push origin HEAD', 'git push --force-with-lease=feat/x:abc origin feat/x', 'git push origin sid-12-fix-main-nav', 'git push -u origin feat/main-menu',
  'git push -u origin sid-7-master-detail-view', 'git status', 'git branch -d x', 'git checkout -- a.txt', 'git restore a.txt', 'git checkout main', 'git stash', 'git stash pop', 'git commit -m "no -n here"',
  'git commit --amend --no-edit', 'git rebase main', 'gh pr create --fill', 'gh pr view 1', 'gh api repos/o/r/pulls/1', 'ls -fd', 'grep -r "git push -f" docs', 'echo "do not git push -f"', 'npm run publish-docs', 'git reset a.txt', 'git reset --soft HEAD~1', 'git clean -n',
  'git replace -l', 'git replace --list', 'git symbolic-ref -q HEAD', 'git symbolic-ref HEAD refs/heads/feat/x', 'git symbolic-ref -m switch HEAD refs/heads/feat/x',
  'git config --get core.bare', 'git config core.bare', 'git config --get-all include.path', 'git config -l', 'git config core.autocrlf false', 'git -c core.autocrlf=false status', 'git push origin feat/x:feat/y', 'git push origin HEAD:refs/heads/feat/x',
  'git push origin feat/x', 'git push -u origin feat/x', // SID-65: branch known and named, stays allowed
  ...allowRemote, // SID-65: remote-tracking rules must not touch ordinary fetch/pull/config/gh reads
];
for (const c of mustAllow) assert.ok(!denied('pre-bash.mjs', bash(c)), `must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);

for (const c of mustDeny.filter((x) => /replace/.test(x) && !/symbolic-ref|--stdin|^git push/.test(x))) assert.match(reasonOf(run('pre-bash.mjs', bash(c))), /replace refs can change what the harness policy reads/, `replace message: ${c}`);
assert.match(reasonOf(run('pre-bash.mjs', bash('git symbolic-ref HEAD refs/remotes/origin/main'))), /git switch/, 'HEAD symref message names git switch');
assert.match(reasonOf(run('pre-bash.mjs', bash('git config core.bare true'))), /git config --get <key>/, 'discovery config message names git config --get');
assert.match(reasonOf(run('pre-bash.mjs', bash('git -c core.bare=true status'))), /git config --get <key>/, 'discovery -c message');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push . x:y'))), /pushing to `\.` writes refs/, 'push-to-dot message');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin x:refs/replace/abc'))), /refs\/remotes\/ or refs\/replace\//, 'push destination message');
assert.match(reasonOf(run('pre-bash.mjs', bash('git fast-import'))), /git fast-import can create or reset any ref/, 'fast-import message');
assert.match(reasonOf(run('pre-bash.mjs', bash('git update-ref --stdin < f'))), /git update-ref refs\/heads\/<name> <commit>/, '--stdin message');

// On a protected branch, a bare push is denied; on a feature branch it is a gated push.
sh(repo, 'git checkout -q main');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push'))), /protected branch main/);
sh(repo, 'git checkout -q feat/x');

// Gate: origin's policy wins over a working-tree edit; commit-and-push chains and dirty trees are refused; pass records HEAD and is skipped next time.
writeFileSync(join(repo, '.harness.json'), JSON.stringify({ gate: [], allowMerge: true }));
assert.ok(denied('pre-bash.mjs', bash('gh pr merge 1')), 'working-tree policy edit must not take effect');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin feat/x'))), /uncommitted/);
sh(repo, 'git checkout -q -- .harness.json');
assert.match(reasonOf(run('pre-bash.mjs', bash('git add -A && git commit -m x && git push origin feat/x'))), /commit in one command/);
sh(repo, 'echo b > b && git add b && git commit -qm b');
assert.equal(run('pre-bash.mjs', bash('git push origin feat/x')), null, 'passing gate allows');
const gitdir = sh(repo, 'git rev-parse --absolute-git-dir');
assert.ok(existsSync(join(gitdir, 'harness-gate', sh(repo, 'git rev-parse HEAD'))), 'gate records HEAD');
assert.match(readFileSync(join(gitdir, 'harness', 'runs.jsonl'), 'utf8'), /"kind":"gate".*"result":"pass".*test -f a/);
assert.equal(run('pre-bash.mjs', bash('gh pr create --fill')), null, 'recorded HEAD skips the gate');
assert.equal(run('pre-bash.mjs', bash('git status')), null, 'gate ignores non-push commands');

// Gate failure shows the tail; a placeholder gate denies; a secret in the committed range denies.
const origin = sh(repo, 'git remote get-url origin');
const setPolicy = (obj) => sh(repo, `git stash -q 2>/dev/null; git checkout -q main && printf '%s' '${JSON.stringify(obj)}' > .harness.json && git commit -qam policy && git push -q origin main && git checkout -q feat/x`);
setPolicy({ gate: ['sh -c "echo lint failed on foo.ts; exit 1"'] });
sh(repo, 'echo c > c && git add c && git commit -qm c');
const g = run('pre-bash.mjs', bash('git push origin feat/x'));
assert.match(reasonOf(g), /lint failed on foo\.ts/);
setPolicy({ gate: ['echo replace with the project checks'] });
sh(repo, 'echo d > d && git add d && git commit -qm d');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin feat/x'))), /placeholder/);
setPolicy({ gate: ['head -c 2000000 /dev/zero | tr "\\0" x'] });
sh(repo, 'echo e > e && git add e && git commit -qm e');
assert.equal(run('pre-bash.mjs', bash('git push origin feat/x')), null, 'large gate output is not a failure');
sh(repo, 'echo "key = AKIAABCDEFGHIJKLMNOP" > s.txt && git add s.txt && git commit -qm s');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin feat/x'))), /AWS key/);
sh(repo, 'git rm -q s.txt && git commit -qm rm');

// Fail closed: a malformed policy on origin denies instead of crashing open.
sh(repo, "git checkout -q main && printf '{bad' > .harness.json && git commit -qam bad && git push -q origin main && git checkout -q feat/x");
assert.match(reasonOf(run('pre-bash.mjs', bash('git push --force origin feat/x'))), /failing closed|force push/);
assert.match(reasonOf(run('pre-bash.mjs', bash('git status'))), /failing closed/);
setPolicy({ gate: ['test -f a'] });

// Linked worktree: .git is a file; gate and stop still work.
const wt = join(repo, '..', 'wt-' + Date.now());
sh(repo, `git worktree add -q -b feat/wt "${wt}" main && cd "${wt}" && echo w > w && git add w && git commit -qm w`);
assert.equal(run('pre-bash.mjs', bash('git push origin feat/wt', wt)), null, 'gate passes in a worktree');
assert.ok(existsSync(join(sh(wt, 'git rev-parse --absolute-git-dir'), 'harness-gate', sh(wt, 'git rev-parse HEAD'))), 'gate records in the worktree git dir');

// Stop: silent with nothing ahead; blocks once per state; never loops; silent outside the harness.
sh(repo, 'git checkout -q main');
assert.equal(run('stop.mjs', { cwd: repo, stop_hook_active: false }), null, 'nothing ahead → silent');
sh(repo, 'git checkout -q feat/x && echo f > f && git add f && git commit -qm f && echo g >> a');
const s = run('stop.mjs', { cwd: repo, stop_hook_active: false });
assert.match(s?.reason ?? '', /uncommitted/);
assert.match(s.reason, /gate .* has not passed/);
assert.equal(run('stop.mjs', { cwd: repo, stop_hook_active: false }), null, 'same state → silent');
assert.equal(run('stop.mjs', { cwd: repo, stop_hook_active: true }), null, 'never loops');
sh(repo, 'git checkout -q -- a');
assert.match(run('stop.mjs', { cwd: repo, stop_hook_active: false })?.reason ?? '', /gate/);
const plain = mkdtempSync(join(tmpdir(), 'plain-'));
sh(plain, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init && echo b > b');
assert.equal(run('stop.mjs', { cwd: plain, stop_hook_active: false }), null, 'repo without .harness.json is left alone');
assert.equal(run('pre-bash.mjs', bash('git push --force', plain))?.hookSpecificOutput?.permissionDecision, 'deny', 'guard still applies without a policy file');

// Policy hook.
for (const f of ['.harness.json', '.claude/settings.json'])
  assert.ok(denied('policy.mjs', { tool_name: 'Edit', tool_input: { file_path: join(repo, f) }, cwd: repo }), `policy denies ${f}`);
assert.ok(!denied('policy.mjs', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/x.ts') }, cwd: repo }));

// Run record: gate and stop outcomes are appended as JSON lines.
const runs = readFileSync(join(gitdir, 'harness', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.ok(runs.some((r) => r.kind === 'gate' && r.result === 'pass'), 'gate pass recorded');
assert.ok(runs.some((r) => r.kind === 'gate' && r.result === 'fail'), 'gate fail recorded');
assert.ok(runs.some((r) => r.kind === 'stop' && r.decision === 'block'), 'stop block recorded');

// Loop brake: unchanged state is a one-time nudge; the same unmet items across three states brake with a report demand.
sh(repo, `rm -f "${gitdir}/harness-stop" && echo h1 >> a`);
assert.match(run('stop.mjs', { cwd: repo, stop_hook_active: false })?.reason ?? '', /round 1 of 3/);
assert.equal(run('stop.mjs', { cwd: repo, stop_hook_active: false }), null, 'same state again is silent');
sh(repo, 'echo h2 >> a');
assert.match(run('stop.mjs', { cwd: repo, stop_hook_active: false })?.reason ?? '', /round 2 of 3/, 'an attempt that did not converge counts');
sh(repo, 'echo h3 >> a');
const r3 = run('stop.mjs', { cwd: repo, stop_hook_active: false });
assert.match(r3?.reason ?? '', /harness brake/, 'third attempt brakes with a report demand');
sh(repo, 'echo h4 >> a');
assert.equal(run('stop.mjs', { cwd: repo, stop_hook_active: false }), null, 'after the brake the turn may end');
sh(repo, 'git checkout -q -- a');
assert.match(run('stop.mjs', { cwd: repo, stop_hook_active: false })?.reason ?? '', /round 1 of 3/, 'a different unmet set starts over');
const runsAfter = readFileSync(join(gitdir, 'harness', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.ok(runsAfter.some((r) => r.kind === 'stop' && r.decision === 'brake'), 'brake recorded');

// Solo repo: an explicit empty protectedBranches turns the push guard off but keeps every other rule.
const solo = mkdtempSync(join(tmpdir(), 'harness-solo-'));
sh(solo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init');
writeFileSync(join(solo, '.harness.json'), JSON.stringify({ protectedBranches: [], gate: [] }));
sh(solo, 'git add .harness.json && git commit -qm p && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin');
assert.equal(run('pre-bash.mjs', bash('git push origin main', solo)), null, 'solo: push to main allowed');
assert.ok(denied('pre-bash.mjs', bash('git push --force origin main', solo)), 'solo: force push still denied');

// SID-65: the policy is the .harness.json committed on origin's base branch (origin/HEAD's branch, then main, then master).
// The working tree is never policy. With none committed the guard fails closed: strict defaults, merges denied, no gate.
// (No existing assertion above needed adapting: none relied on the working-tree fallback.)
{
  const { config } = await import(join(hooks, 'lib.mjs'));
  const made = [];
  const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `harness-sid65-${name}-`)); made.push(d, `${d}.origin.git`); return d; };
  const mk = (name) => { // repo on feat/x, bare origin with main only (no policy), origin/HEAD unset
    const d = scratch(name);
    sh(d, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git checkout -q -b feat/x');
    return d;
  };
  const policyOn = (d, branch, obj) => sh(d, `git checkout -q -B ${branch} $(git rev-parse -q --verify origin/${branch} || echo HEAD) && printf '%s' '${JSON.stringify(obj)}' > .harness.json && git add .harness.json && git commit -qm policy && git push -q origin ${branch} && git checkout -q feat/x && git branch -q -D ${branch}`);
  const verdict = (d, c) => { const r = run('pre-bash.mjs', bash(c, d)); return { deny: r?.hookSpecificOutput?.permissionDecision === 'deny', why: reasonOf(r) }; };
  const local = { allowMerge: true, protectedBranches: ['develop'] };
  try {
    // a. untracked working-tree policy is ignored
    const a = mk('a');
    writeFileSync(join(a, '.harness.json'), JSON.stringify(local));
    const ca = config(a);
    assert.deepEqual([ca.present, ca.allowMerge, ca.source, ca.ignoredLocal], [false, false, null, true], 'a: untracked policy is not read');
    const ma = verdict(a, 'gh pr merge 1');
    assert.ok(ma.deny, 'a: merge denied');
    assert.match(ma.why, /policy: none committed on origin \(checked origin\/main, origin\/master\)/);
    assert.match(ma.why, /working-tree \.harness\.json is NOT trusted/);
    assert.match(ma.why, /templates\/harness\.json/);
    assert.match(ma.why, /git fetch origin/);
    assert.ok(verdict(a, 'git push origin feat:main').deny, 'a: push to main denied');
    assert.ok(!verdict(a, 'git push origin feat:develop').deny, 'a: the ignored file does not move protection to develop');

    // b. committed on the feature branch only (badminton-stats case): still ignored
    const b = mk('b');
    writeFileSync(join(b, '.harness.json'), JSON.stringify(local));
    sh(b, 'git add .harness.json && git commit -qm policy');
    const cb = config(b);
    assert.deepEqual([cb.present, cb.allowMerge, cb.ignoredLocal], [false, false, true], 'b: branch-only policy is not read');
    assert.ok(verdict(b, 'gh pr merge 1').deny, 'b: merge denied');
    assert.ok(verdict(b, 'git push origin feat:main').deny, 'b: push to main denied');

    // c. policy only on origin/develop, origin/HEAD -> develop
    const c = mk('c');
    policyOn(c, 'develop', { gate: [] });
    sh(c, 'git remote set-head origin develop');
    const cc = config(c);
    assert.deepEqual([cc.present, cc.source, cc.base], [true, 'origin/develop', 'develop'], 'c: found beyond main/master');
    const pc = verdict(c, 'git push origin feat:develop');
    assert.ok(pc.deny, 'c: push to develop denied');
    assert.match(pc.why, /policy: \.harness\.json on origin\/develop/);
    assert.ok(verdict(c, 'gh pr merge 1').deny, 'c: allowMerge defaults to false');
    policyOn(c, 'develop', { gate: [], allowMerge: true });
    sh(c, 'git fetch -q origin');
    assert.ok(!verdict(c, 'gh pr merge 1').deny, 'c: a committed allowMerge is honoured');
    assert.match(verdict(c, 'git push origin feat:develop').why, /policy: \.harness\.json on origin\/develop/);

    // d. origin/HEAD unset, policy only on origin/master
    const d = mk('d');
    policyOn(d, 'master', { gate: [] });
    const cd = config(d);
    assert.deepEqual([cd.present, cd.source, cd.base], [true, 'origin/master', 'master'], 'd: master fallback');

    // e. no policy, origin/HEAD -> develop: develop is protected by the defaults, main still is
    const e = mk('e');
    sh(e, 'git push -q origin feat/x:develop && git fetch -q origin && git remote set-head origin develop');
    const ce = config(e);
    assert.deepEqual([ce.present, ce.base, [...ce.protectedBranches].sort()], [false, 'develop', ['develop', 'main', 'master']], 'e: remote default is protected');
    assert.ok(verdict(e, 'git push origin feat:develop').deny, 'e: push to develop denied');
    assert.ok(verdict(e, 'git push origin feat:main').deny, 'e: push to main denied');
    assert.match(verdict(e, 'gh pr merge 1').why, /protected: main, master, develop/);

    // f. committed protectedBranches without the base: the base is added
    const f = mk('f');
    policyOn(f, 'main', { protectedBranches: ['release'] });
    const cf = config(f);
    assert.deepEqual([...cf.protectedBranches].sort(), ['main', 'release'], 'f: base added');
    assert.ok(verdict(f, 'git push origin feat:main').deny, 'f: main still protected');
    assert.ok(verdict(f, 'git push origin feat:release').deny, 'f: release protected');
    assert.ok(!verdict(f, 'git push origin feat/x').deny, 'f: a feature branch is not');

    // g. the documented adoption path: no policy, a human merges one on origin, git fetch origin
    const g = mk('g');
    assert.ok(verdict(g, 'gh pr merge 1').deny, 'g: denied before adoption');
    assert.ok(!verdict(g, 'git push origin feat/x').deny && !existsSync(join(g, 'gate-ran')), 'g: no policy, no gate run');
    const human = scratch('g-human');
    sh(human, `git clone -q "${g}.origin.git" . && git config user.email h@h && git config user.name h && printf '%s' '${JSON.stringify({ allowMerge: true, gate: ['touch gate-ran'] })}' > .harness.json && git add .harness.json && git commit -qm policy && git push -q origin main`);
    assert.equal(config(g).present, false, 'g: stale origin/main until fetch');
    sh(g, 'git fetch -q origin');
    const cg = config(g);
    assert.deepEqual([cg.present, cg.source, cg.allowMerge], [true, 'origin/main', true], 'g: adopted after fetch');
    assert.ok(!verdict(g, 'gh pr merge 1').deny, 'g: merge allowed after adoption');
    assert.ok(!verdict(g, 'git push origin feat/x').deny && existsSync(join(g, 'gate-ran')), 'g: the committed gate runs');

    // h. remote-tracking refs locate the policy, so local rewrites are refused; each message names the allowed alternative
    const SET_HEAD = /read from origin\/HEAD's branch.*Use `git remote set-head origin --auto`/;
    const SYMREF = /Read them with `git symbolic-ref --short refs\/remotes\/origin\/HEAD`; sync them with `git fetch origin` or `git remote set-head origin --auto`/;
    const UPDATE_REF = /Update them with `git fetch origin`; to move a local branch use `git update-ref refs\/heads\/<name> <commit>`/;
    const FETCH_DST = /Use `git fetch origin <branch>`.*`git fetch origin <branch>:<local-branch>`/;
    const FETCH_CFG = /remote\.<name>\.fetch decides what refs\/remotes\/\* hold.*`git fetch origin <branch>`.*`git config --get-all remote\.origin\.fetch`/;
    const OVERRIDE = /per-command remote\.<name>\.fetch override.*Use `git fetch origin <branch>` instead; other -c settings are fine/;
    const REPO_EDIT = /repo-admin action on GitHub\. Read them with `gh repo view --json <fields>`/;
    const cases = [
      [SET_HEAD, ['git remote set-head origin feat/x', 'git remote set-head origin -d', 'git remote set-head origin --delete']],
      [SYMREF, ['git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feat/x', 'git symbolic-ref -d refs/remotes/origin/HEAD']],
      [UPDATE_REF, ['git update-ref refs/remotes/origin/main HEAD']],
      [FETCH_DST, ['git fetch origin x:refs/remotes/origin/main', 'git fetch origin +x:refs/remotes/origin/main', "git fetch origin 'x:refs/remotes/origin/main'", 'git pull origin x:refs/remotes/origin/main']],
      [FETCH_CFG, ['git config remote.origin.fetch +refs/heads/x:refs/remotes/origin/main', "git config remote.origin.fetch '+refs/heads/x:refs/remotes/origin/main'", 'git config --add remote.origin.fetch x',
        'git config --replace-all remote.origin.fetch x', 'git config --unset remote.origin.fetch', 'git config --unset-all remote.origin.fetch', 'git config --global remote.origin.fetch x', 'git config set remote.origin.fetch x']],
      [OVERRIDE, ['git -c remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main fetch', "git -c 'remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main' fetch origin", 'git --config-env=remote.origin.fetch=X fetch',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.fetch GIT_CONFIG_VALUE_0=x git fetch', "GIT_CONFIG_PARAMETERS=\"'remote.origin.fetch'='x'\" git fetch", "GIT_CONFIG_PARAMETERS=\"'remote.origin.fetch=x'\" git fetch"]],
      [REPO_EDIT, ['gh repo edit --default-branch feat/x', 'gh repo edit o/r --description x']],
    ];
    for (const [msg, cmds] of cases) for (const cmd of cmds) {
      const v = verdict(a, cmd);
      assert.ok(v.deny, `h: must deny: ${cmd}`);
      assert.match(v.why, msg, cmd);
    }
    for (const cmd of ['git update-ref -d refs/remotes/origin/main', 'git update-ref -d remotes/origin/main']) {
      const v = verdict(a, cmd);
      assert.ok(v.deny, `h: must deny: ${cmd}`);
      assert.match(v.why, UPDATE_REF, `h: ${cmd} names the alternative`);
    }
    assert.match(verdict(a, 'git update-ref -d refs/heads/x').why, /history rewriting is not allowed/, 'h: update-ref -d on a local branch stays a history-rewriting deny');
    assert.match(verdict(a, 'gh repo delete o/r').why, /guard: releases, repo lifecycle, secrets, and workflow triggers are human actions\n/, 'h: lifecycle message unchanged');
    // none of the above may over-block ordinary fetch, pull, config, set-head --auto, or gh reads
    for (const cmd of allowRemote) assert.ok(!verdict(a, cmd).deny, `h: must allow: ${cmd} (${verdict(a, cmd).why})`);

    // i. the reset --hard advice never suggests stash
    const ri = verdict(a, 'git reset --hard');
    assert.ok(ri.deny && !/stash/.test(ri.why) && /git restore/.test(ri.why), 'i: reset advice names git restore, not stash');

    // j. SessionStart says so when it ignores a working-tree policy; stays quiet otherwise
    const ctxOf = (cwd) => run('session-start.mjs', { hook_event_name: 'SessionStart', cwd }).hookSpecificOutput.additionalContext;
    assert.match(ctxOf(a), /working-tree \.harness\.json is ignored/);
    assert.match(ctxOf(a), /templates\/harness\.json/);
    assert.match(ctxOf(b), /working-tree \.harness\.json is ignored/);
    assert.doesNotMatch(ctxOf(g), /\.harness\.json is ignored/, 'j: committed policy, nothing ignored');
    assert.doesNotMatch(ctxOf(tmpdir()), /\.harness\.json is ignored/, 'j: non-repo cwd unchanged');
    assert.equal(JSON.parse(execFileSync('node', [join(hooks, 'session-start.mjs')], { input: 'not json', cwd: tmpdir() }).toString()).hookSpecificOutput.hookEventName, 'SessionStart', 'j: garbage input still valid');

    // k. ref shadowing: `origin/main` resolves refs/tags/origin/main and refs/heads/origin/main before refs/remotes/origin/main,
    // and an agent may create both. The policy lookup, remoteDefault, the gate base and the Stop count use full refs/remotes/ names.
    const permissive = { allowMerge: true, protectedBranches: [] };
    const evilCommit = (d, branch) => sh(d, `git checkout -q -b ${branch} && printf '%s' '${JSON.stringify(permissive)}' > .harness.json && git add .harness.json && git commit -qm evil && git rev-parse HEAD && git checkout -q feat/x`); // branch kept; returns the sha
    const strict = { protectedBranches: ['main'], allowMerge: false };
    const strictRepo = (name) => { const d = mk(name); policyOn(d, 'main', strict); return d; };
    const holdsStrict = (d, tag) => {
      const ck = config(d);
      assert.deepEqual([ck.present, ck.source, ck.allowMerge, ck.protectedBranches.includes('main')], [true, 'origin/main', false, true], `${tag}: real origin/main policy wins`);
      assert.ok(verdict(d, 'gh pr merge 1').deny, `${tag}: merge denied`);
      assert.ok(verdict(d, 'git push origin HEAD:main').deny, `${tag}: push to main denied`);
      assert.match(verdict(d, 'gh pr merge 1').why, /policy: \.harness\.json on origin\/main/, `${tag}: policyNote names origin/main`);
    };
    const k1 = strictRepo('k1');
    sh(k1, `git tag origin/main ${evilCommit(k1, 'evil')}`);
    holdsStrict(k1, 'k1 (tag)');
    const k2 = strictRepo('k2');
    sh(k2, `git branch origin/main ${evilCommit(k2, 'evil')}`);
    holdsStrict(k2, 'k2 (branch)');

    const k3 = mk('k3'); // no policy on origin: a shadow must not conjure one
    const e3 = evilCommit(k3, 'evil');
    for (const [kind, cmd] of [['tag', `git tag origin/main ${e3}`], ['branch', `git branch origin/main ${e3}`]]) {
      sh(k3, cmd);
      const c3 = config(k3);
      assert.deepEqual([c3.present, c3.allowMerge], [false, false], `k3 (${kind}): shadow policy not read`);
      assert.ok(verdict(k3, 'gh pr merge 1').deny, `k3 (${kind}): merge denied`);
      sh(k3, kind === 'tag' ? 'git tag -d origin/main' : 'git branch -q -D origin/main');
    }

    const { remoteDefault, baseCandidates } = await import(join(hooks, 'lib.mjs'));
    const k4 = strictRepo('k4'); // origin/HEAD pointing at a non-remote ref is ignored, as if unset
    evilCommit(k4, 'evil');
    sh(k4, 'git symbolic-ref refs/remotes/origin/HEAD refs/heads/evil');
    assert.equal(remoteDefault(k4), null, 'k4: non-remote symref ignored');
    assert.deepEqual(baseCandidates(k4), ['main', 'master'], 'k4: falls back to main/master');
    holdsStrict(k4, 'k4');
    sh(k4, 'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    assert.equal(remoteDefault(k4), 'main', 'k4: a real remote symref still resolves');

    const k5 = mk('k5'); // gate {base} is the merge-base with the real origin/main, not a shadowing tag at HEAD
    policyOn(k5, 'main', { gate: ['printf %s {base} > base.txt'] });
    sh(k5, 'git commit -q --allow-empty -m work && git tag origin/main HEAD');
    const realBase = sh(k5, 'git merge-base HEAD refs/remotes/origin/main'); // != HEAD, which a tag-resolved merge-base would give
    assert.ok(!verdict(k5, 'git push origin feat/x').deny, 'k5: gate passes');
    assert.equal(readFileSync(join(k5, 'base.txt'), 'utf8'), realBase, 'k5: {base} comes from refs/remotes/origin/main, not the tag');
    // k5 (stop.mjs ahead count) not covered here: it needs a Stop-hook fixture; the change is the same one-token ref name.

    // k6. a MISSING remote ref must not be conjured by refs/tags/refs/remotes/... or refs/heads/refs/remotes/... (rev-parse DWIM fallback).
    const { remoteSha } = await import(join(hooks, 'lib.mjs'));
    const shadows = [['tag', (n, e) => `git tag ${n} ${e}`, (n) => `git tag -d ${n}`], ['branch', (n, e) => `git branch ${n} ${e}`, (n) => `git branch -q -D ${n}`]];
    const failsClosed = (d, tag, names) => {
      const c = config(d);
      assert.deepEqual([c.present, c.allowMerge, c.source], [false, false, null], `${tag}: shadow policy not read`);
      for (const n of names) assert.ok(c.protectedBranches.includes(n), `${tag}: ${n} protected`);
      assert.ok(verdict(d, 'gh pr merge 1').deny, `${tag}: merge denied`);
      for (const n of names) assert.ok(verdict(d, `git push origin HEAD:${n}`).deny, `${tag}: push to ${n} denied`);
    };
    const k6m = mk('k6m'); // origin has main only: refs/remotes/origin/master is missing
    const e6m = evilCommit(k6m, 'evil');
    for (const [kind, mkShadow, rmShadow] of shadows) {
      sh(k6m, mkShadow('refs/remotes/origin/master', e6m));
      assert.equal(remoteSha(k6m, 'master'), null, `k6 master (${kind}): no remote sha`);
      failsClosed(k6m, `k6 master (${kind})`, ['main', 'master']);
      sh(k6m, rmShadow('refs/remotes/origin/master'));
    }
    assert.match(remoteSha(k6m, 'main'), /^[0-9a-f]{40,64}$/, 'k6: a real remote ref still yields its sha');
    assert.equal(remoteSha(k6m, '..'), null, 'k6: implausible name rejected');
    assert.equal(remoteSha(k6m, '-x'), null, 'k6: leading dash rejected');
    assert.equal(remoteSha(k6m, 'a b'), null, 'k6: whitespace rejected');

    const k6t = mk('k6t'); // origin has only trunk (HEAD -> trunk, no policy): refs/remotes/origin/main is missing
    const origin6 = `${k6t}.origin.git`;
    sh(k6t, `git push -q origin main:trunk && git --git-dir=${origin6} symbolic-ref HEAD refs/heads/trunk && git --git-dir=${origin6} branch -q -D main && git fetch -q --prune origin && git remote set-head origin --auto`);
    assert.equal(sh(k6t, 'git for-each-ref refs/remotes/origin/main | wc -l'), '0', 'k6 main: refs/remotes/origin/main is gone');
    const e6t = evilCommit(k6t, 'evil');
    for (const [kind, mkShadow, rmShadow] of shadows) {
      sh(k6t, mkShadow('refs/remotes/origin/main', e6t));
      assert.equal(remoteSha(k6t, 'main'), null, `k6 main (${kind}): no remote sha`);
      failsClosed(k6t, `k6 main (${kind})`, ['main']);
      sh(k6t, rmShadow('refs/remotes/origin/main'));
    }
    assert.equal(remoteDefault(k6t), 'trunk', 'k6: real default still resolves');

    const k6g = mk('k6g'); // shadow tag at HEAD, remote master missing: baseSha is the real main, never the tag
    sh(k6g, 'git commit -q --allow-empty -m work && git tag refs/remotes/origin/master HEAD');
    const g6 = config(k6g);
    assert.deepEqual([g6.present, g6.baseSha === remoteSha(k6g, 'main')], [false, true], 'k6 gate: not present, baseSha is the real main');

    // k7. replace refs: `git show <sha>:.harness.json` follows refs/replace/<sha>, so the hooks run git with --no-replace-objects.
    const REPLACE = /replace refs can change what the harness policy reads/;
    const plant = (d) => sh(d, `git update-ref refs/replace/$(git rev-parse refs/remotes/origin/main) ${evilCommit(d, 'evil')}`); // bypasses the hook on purpose
    const k7 = mk('k7'); // no policy on origin
    const cmd7 = `git update-ref refs/replace/${sh(k7, 'git rev-parse refs/remotes/origin/main')} ${evilCommit(k7, 'evil')}`;
    assert.match(verdict(k7, cmd7).why, REPLACE, 'k7: the guard denies planting the replace');
    sh(k7, cmd7);
    const c7 = config(k7);
    assert.deepEqual([c7.present, c7.allowMerge, c7.protectedBranches.includes('main')], [false, false, true], 'k7: replace does not conjure a policy');
    assert.ok(verdict(k7, 'gh pr merge 1').deny, 'k7: merge denied');
    const k7s = strictRepo('k7s');
    plant(k7s);
    holdsStrict(k7s, 'k7 strict');
    const k7t = strictRepo('k7t'); // replace the policy blob too
    sh(k7t, `git update-ref refs/replace/$(git rev-parse refs/remotes/origin/main:.harness.json) $(printf '%s' '${JSON.stringify(permissive)}' | git hash-object -w --stdin)`);
    holdsStrict(k7t, 'k7 strict blob');
    const k7h = strictRepo('k7h'); // HEAD steering: pointing HEAD at origin/main then resetting would move it
    assert.match(verdict(k7h, 'git symbolic-ref HEAD refs/remotes/origin/main').why, /git switch/, 'k7 symref: denied');
    assert.ok(!verdict(k7h, 'git symbolic-ref HEAD refs/heads/feat/x').deny && !verdict(k7h, 'git symbolic-ref HEAD').deny, 'k7 symref: local branch and reads allowed');

    // k8. git can't read the repository: the guard must still apply, with strict defaults (a permissive committed policy must not matter).
    const unreadable = [
      ['bare', (d) => 'git config core.bare true'],
      ['fmt', (d) => 'git config core.repositoryformatversion 9'],
      ['include', (d) => { const f = join(d, 'bad.inc'); writeFileSync(f, '[bad'); return `git config include.path ${f}`; }],
    ];
    for (const [tag, setup] of unreadable) {
      const d = mk(`k8${tag}`);
      policyOn(d, 'main', { allowMerge: true, protectedBranches: [] });
      assert.ok(!verdict(d, 'gh pr merge 1 -R o/r').deny, `k8 ${tag}: sanity, the permissive policy allows merge while readable`);
      const setupCmd = setup(d);
      assert.ok(verdict(d, setupCmd).deny, `k8 ${tag}: the guard refuses the setup command`);
      sh(d, setupCmd); // bypass the guard
      if (tag === 'bare') { // git can still find the git dir, so the committed policy is read through it (no work tree)
        const c8b = config(d);
        assert.equal(c8b.root, realpathSync(join(d, '.git')), 'k8 bare: root is the absolute git dir');
        assert.ok(c8b.noWorkTree === true && !c8b.unreadable && c8b.present === true, 'k8 bare: noWorkTree, readable, committed policy in force');
        assert.ok(!verdict(d, 'gh pr merge 1').deny, 'k8 bare: the committed policy (allowMerge true) is in force');
        for (const cmd of ['git push -f origin HEAD:main', 'git push --force origin feat/x', 'git reset --hard HEAD~1']) assert.ok(verdict(d, cmd).deny, `k8 bare: must deny: ${cmd}`);
        for (const cmd of ['ls', 'gh pr view 1 -R o/r', 'npm test', 'git status']) assert.ok(!verdict(d, cmd).deny, `k8 bare: must allow: ${cmd}`);
        continue;
      }
      const c8 = config(d);
      assert.ok(c8.root === null && c8.unreadable === true, `k8 ${tag}: git can't read the repo`);
      for (const cmd of ['git push -f origin HEAD:main', 'git push --force origin feat/x', 'gh pr merge 1 -R o/r', 'gh pr merge 1', 'git reset --hard HEAD~1'])
        assert.ok(verdict(d, cmd).deny, `k8 ${tag}: must deny: ${cmd}`);
      assert.match(verdict(d, 'gh pr merge 1').why, /could not read a repository/, `k8 ${tag}: message says git could not read the repository`);
      if (tag === 'fmt') for (const cmd of ['gh pr merge 1', 'gh pr close 1']) {
        const w = verdict(d, cmd).why;
        assert.match(w, /guard: git can't read this repository, so strict defaults apply; fix the repo config \(core\.bare, core\.repositoryformatversion, core\.worktree, include\.path\)/, `k8 fmt: ${cmd} leads with the unreadable wording`);
        assert.doesNotMatch(w, /set allowMerge/, `k8 fmt: ${cmd} does not suggest allowMerge`);
      }
      for (const cmd of ['ls', 'gh pr view 1 -R o/r', 'npm test', 'git status']) assert.ok(!verdict(d, cmd).deny, `k8 ${tag}: must allow: ${cmd}`);
      // SID-66 shell-write rules still apply with no readable repo (the cwd stands in for the root); reads and copies out stay allowed
      for (const cmd of ['echo x > .harness.json', 'cp x/.harness.json .', 'cp a .claude/settings.json']) assert.ok(verdict(d, cmd).deny, `k8 ${tag}: SID-66 must deny: ${cmd}`);
      for (const cmd of ['cat .harness.json', 'cp .harness.json /tmp/', 'jq . .harness.json']) assert.ok(!verdict(d, cmd).deny, `k8 ${tag}: SID-66 must allow: ${cmd} (${verdict(d, cmd).why})`);
    }
    const nonRepo = mkdtempSync(join(tmpdir(), 'harness-sid65-k8n-'));
    made.push(nonRepo);
    for (const cmd of ['gh pr merge 1 -R o/r', 'git push -f origin HEAD:main']) assert.ok(verdict(nonRepo, cmd).deny, `k8 non-repo: must deny: ${cmd}`);
    for (const cmd of ['ls', 'git clone /nonexistent/x.git', 'git init', 'gh pr view 1 -R o/r']) assert.ok(!verdict(nonRepo, cmd).deny, `k8 non-repo: must allow: ${cmd}`);
    for (const cmd of ['echo x > .harness.json', 'cp x/.harness.json .']) assert.ok(verdict(nonRepo, cmd).deny, `k8 non-repo: SID-66 must deny: ${cmd}`);
    for (const cmd of ['cat .harness.json', 'cp .harness.json /tmp/', 'cp .harness.json backup/']) assert.ok(!verdict(nonRepo, cmd).deny, `k8 non-repo: SID-66 must allow: ${cmd} (${verdict(nonRepo, cmd).why})`);

    // k9. Branch unknown: the hook cwd's branch is not what a push updates when git has no work tree (cwd inside .git, core.bare) or the command
    // targets another repository. Then a push must name its branch. With the branch known and no retargeting, behaviour is unchanged.
    const { retargets } = await import(join(hooks, 'guard-rules.mjs'));
    const { currentBranch } = await import(join(hooks, 'lib.mjs'));
    const NAME = /name the branch: git push origin <branch>/;
    for (const c of ['git -C /x push', 'git -C/x push', 'git --git-dir=/x/.git push', 'git --git-dir /x/.git --work-tree /x push', 'GIT_DIR=/x/.git git push', 'GIT_WORK_TREE=/x git push', 'export GIT_DIR=/x; git push', 'env GIT_DIR=/x git push',
      'cd /x && git push', 'cd /x; git push origin HEAD', 'pushd /x && git push', '(cd /x && git push)', 'sh -c "cd /x && git push"', 'git -c a=b -C /x push', 'git --no-pager -C /x push']) assert.ok(retargets(c), `retargets: ${c}`);
    for (const c of ['git push origin feat/x', 'git push', 'git commit -C abc', 'git log -C', 'git commit -m "cd fix" && git push', 'git -c a=b push', 'git --no-pager push origin feat/x', 'cd /x', 'git push && cd /x', 'echo hi && git push -u origin feat/x']) assert.ok(!retargets(c), `does not retarget: ${c}`);

    // 1. cwd inside .git, on main, no policy (strict defaults): the branch is read from the git dir, so the protected-branch rule applies.
    const k9a = mk('k9a');
    sh(k9a, 'git checkout -q main');
    const inGit = join(k9a, '.git');
    assert.equal(currentBranch(config(inGit).root), 'main', 'k9 1: branch known from inside .git');
    for (const c of ['git push', 'git push origin', 'git push origin HEAD', 'git push origin @', 'git push -u origin', 'git push --force-with-lease', 'git push --force-with-lease=main:abc', 'git push origin main'])
      assert.ok(verdict(inGit, c).deny, `k9 1: must deny: ${c}`);
    assert.match(verdict(inGit, 'git push origin HEAD').why, /you are on protected branch main; create a feature branch and push that/, 'k9 1: protected-branch message, branch now known');
    assert.ok(!verdict(inGit, 'git push origin feat/x').deny && !verdict(inGit, 'git push origin HEAD:feat/x').deny, 'k9 1: an explicit non-protected destination is fine (no policy, no gate)');
    // e2e: the verdict is a deny, so the push never runs and origin main stays put.
    const originMain = () => sh(k9a, 'git --git-dir="$(pwd).origin.git" rev-parse refs/heads/main');
    const before = originMain();
    assert.ok(verdict(inGit, 'git push origin HEAD').deny && originMain() === before, 'k9 1: origin main did not move');
    // SID-66 with no work tree: the repo-root .harness.json is the git dir's parent, not <git dir>/.harness.json.
    for (const c of ['cp x/.harness.json ..', 'cp x/.harness.json ../', 'echo x > ../.harness.json']) assert.ok(verdict(inGit, c).deny, `k9 1: SID-66 must deny from inside .git: ${c}`);
    for (const c of ['cp ../.harness.json /tmp/', 'cat ../.harness.json']) assert.ok(!verdict(inGit, c).deny, `k9 1: SID-66 must allow from inside .git: ${c}`);

    // 2. committed policy protects develop; checked out on develop; cwd inside .git.
    const k9b = mk('k9b');
    policyOn(k9b, 'main', { protectedBranches: ['develop'] });
    sh(k9b, 'git checkout -q -b develop');
    const inGitB = join(k9b, '.git');
    const c9 = config(inGitB);
    assert.ok(c9.present === true && c9.noWorkTree === true && currentBranch(c9.root) === 'develop', 'k9 2: policy read through the git dir, branch develop');
    for (const c of ['git push', 'git push origin HEAD', 'git push origin develop']) assert.ok(verdict(inGitB, c).deny, `k9 2: must deny: ${c}`);
    assert.match(verdict(inGitB, 'git push origin feat/y').why, /git sees no work tree here .* run the push from the repository's work tree/, 'k9 2: a push that would run the gate says what to do');

    // 3. core.bare=true on a normal checkout (set past the guard).
    const k9c = mk('k9c');
    sh(k9c, 'git checkout -q main && git config core.bare true');
    assert.equal(config(k9c).noWorkTree, true, 'k9 3: no work tree');
    for (const c of ['git push', 'git push origin HEAD']) assert.ok(verdict(k9c, c).deny, `k9 3: must deny: ${c}`);

    // 4. cross-repo: cwd is A on feat/x, the push lands in B, which is on main.
    const k9d = mk('k9d'), B = mk('k9dB');
    sh(B, 'git checkout -q main');
    for (const c of [`git -C ${B} push`, `git -C ${B} push origin`, `git -C ${B} push origin HEAD`, `cd ${B} && git push`, `cd ${B}; git push origin HEAD`, `git --git-dir=${B}/.git push`,
      `git --git-dir ${B}/.git --work-tree ${B} push`, `GIT_DIR=${B}/.git git push`, `GIT_WORK_TREE=${B} git push`]) {
      const v = verdict(k9d, c);
      assert.ok(v.deny && NAME.test(v.why), `k9 4: must deny with the name-the-branch message: ${c} (${v.why})`);
    }
    for (const c of [`git -C ${B} push origin feat/y`, `cd ${B} && git push -u origin feat/y`, `git -C ${B} status`, `cd ${B} && git log -1`]) assert.ok(!verdict(k9d, c).deny, `k9 4: must allow: ${c}`);
    assert.ok(verdict(k9d, 'git -C . push --force origin feat/x').deny, 'k9 4: force still denied');

    // 5. over-blocking guard: normal cwd on feat/x, nothing retargeted.
    for (const c of ['git push', 'git push -u origin feat/x', 'git push origin feat/x', 'git push origin HEAD', 'git push origin @']) assert.ok(!verdict(k9d, c).deny, `k9 5: must allow: ${c}`);
    assert.ok(verdict(k9d, 'git push origin main').deny, 'k9 5: main still denied');

    // 6. allowMerge is honoured only as the boolean true.
    for (const [v, want] of [['false', true], [1, true], ['true', true], [true, false]]) {
      const m = mk('k9m');
      policyOn(m, 'main', { allowMerge: v });
      assert.equal(verdict(m, 'gh pr merge 1').deny, want, `k9 allowMerge ${JSON.stringify(v)}: merge ${want ? 'denied' : 'allowed'}`);
    }

    // 7. fsmonitor: a configured fsmonitor script must not run inside the hook (the gate's git status).
    const k9f = mk('k9f');
    policyOn(k9f, 'main', { gate: ['true'] });
    const marker = join(k9f, 'fsmonitor-ran');
    writeFileSync(join(k9f, 'fsm.sh'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(k9f, 'fsm.sh'), 0o755);
    sh(k9f, `git config core.fsmonitor '${join(k9f, 'fsm.sh')}'`);
    sh(k9f, 'git status --porcelain'); // sanity: git itself does run the script
    assert.ok(existsSync(marker), 'k9 fsmonitor: sanity, git runs the script');
    rmSync(marker);
    assert.ok(!verdict(k9f, 'git push origin feat/x').deny, 'k9 fsmonitor: the gate push still passes');
    assert.ok(!existsSync(marker), 'k9 fsmonitor: the hook did not run the fsmonitor script');
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
}

// SID-66: the policy files (.harness.json, .claude/settings*.json) are not written from the shell either (redirects, tee, cp/mv/ln/install/rsync, rm, in-place editors, git checkout/restore, interpreter one-liners that write).
// Deny messages say what to do instead; narrow rules, so normal work stays allowed. Symlink defence and the SID-65 backstop are covered too.
{
  const made = [];
  const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `harness-sid66-${name}-`)); made.push(d, `${d}.origin.git`); return d; };
  const mkNone = (name) => { // repo on feat/x, bare origin with main only: no policy committed
    const d = scratch(name);
    sh(d, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git checkout -q -b feat/x');
    return d;
  };
  const verdict = (d, c) => { const r = run('pre-bash.mjs', bash(c, d)); return { deny: r?.hookSpecificOutput?.permissionDecision === 'deny', why: reasonOf(r) }; };
  const sid66Deny = [
    "cat > .harness.json <<'J'\n{\"allowMerge\":true}\nJ", "echo '{}' > .harness.json", "echo '{}' >> ./.harness.json", 'printf x >| .harness.json', 'echo x 1> .harness.json', 'echo x &> .harness.json', 'echo x>.harness.json',
    'cp /dev/null .claude/settings.json', 'cp templates/harness.json .harness.json', 'cp x/settings.json .claude/', 'cp -t .claude x/settings.json', 'install -m644 a .harness.json', 'rsync a .claude/settings.local.json',
    'ln -sf /tmp/p .harness.json', 'ln -s .harness.json p', 'mv .harness.json old.json', 'mv new.json .harness.json', 'rm .harness.json', 'rm -f .claude/settings.local.json', 'truncate -s0 .harness.json', 'dd if=a of=.harness.json',
    'tee .harness.json', 'echo x | tee -a .claude/settings.json', 'sed -i s/false/true/ .harness.json', 'sed -i.bak s/a/b/ .claude/settings.json', "sed -i -e 's/.*/x/' .harness.json", 'perl -pi -e s/a/b/ .harness.json',
    'git checkout origin/feat -- .harness.json', 'git checkout feat .harness.json', 'git -C . checkout main -- .harness.json', 'git restore --source=feat .harness.json', 'git restore .claude/settings.json', 'git mv a .harness.json', 'git rm .harness.json',
    'sh -c "echo {} > .harness.json"', "bash -c 'cp a .claude/settings.json'", `node -e "require('fs').writeFileSync('.harness.json','{}')"`, `python3 -c "open('.harness.json','w').write('{}')"`, `python3 -c "import os; os.unlink('.harness.json')"`,
    // whole .claude directory: delete, move, replace, restore
    'rm -rf .claude', 'rm -r .claude/', 'rm -R ~/.claude', 'rm --recursive $HOME/.claude', 'rm -fr sub/.claude', 'rm -rf ./.claude/.', 'mv .claude old', 'mv old .claude', 'mv .claude ~/bak', 'mv x -t .claude',
    'cp -r other/.claude .claude', 'cp -r ../a/.claude .claude/', 'rsync -a --delete other/.claude/ .claude/', 'ln -sfn ../shared/.claude .claude', 'git checkout main -- .claude', 'git checkout origin/feat .claude', 'git checkout -- .claude',
    'git restore .claude', 'git restore --source=main --worktree .claude', 'git restore -S -W .claude', 'git rm -r .claude', 'git rm -rf .claude', 'git mv .claude old', 'sh -c "rm -rf .claude"', 'cd sub && rm -rf .claude',
    // mv of a policy file removes the policy, so it stays denied; globs that could hit the policy stay denied
    'mv .harness.json backup/', 'rm .*', 'mv .* x/',
    // copies that land ON the root policy (dir destination resolved against cwd) or on a .claude/settings*.json; explicit policy-named destinations
    'cp a .harness.json', 'cp a .claude/settings.json', 'cp x/settings.json .claude', 'cp sub/.harness.json .', 'cp sub/.harness.json ./', 'cp -t . sub/.harness.json', 'cp a sub/.harness.json', 'cd sub && cp ../x/.harness.json ..',
    // interpreter one-liners that write or delete a policy file
    `python3 -c "from pathlib import Path; Path('.harness.json').write_text('{}')"`, `node -e "require('fs').rmSync('.claude/settings.json')"`, `node -e "require('fs').copyFileSync('/tmp/x', '.harness.json')"`, `python3 -c "import shutil; shutil.copy('x', '.harness.json')"`,
    `ruby -e "File.write('.harness.json', '{}')"`, `perl -e "open(F, '>', '.harness.json'); print F 1"`, `python3 -c "open('.harness.json', mode='w').write('{}')"`, `deno eval "Deno.remove('.harness.json')"`,
    'echo x > sub/dir/.harness.json', 'echo x > "$HOME/.claude/settings.json"', 'echo x > ~/.claude/settings.json', 'echo x > .harness.*', 'cp a .claude/settings*.json', 'cd sub && echo x > ../.harness.json', "echo ok && echo '{}' > .harness.json",
    // wrappers: options and their values are skipped through the shared unwrap helper (lib.mjs), then the real command is judged
    'nice -n 5 cp x .claude/settings.json', 'nice -n5 tee .harness.json', 'sudo -u root cp x .claude/settings.json', 'sudo -E -u root rm .harness.json', 'doas -u root cp x .harness.json', 'timeout 5 cp x .claude/settings.json', 'timeout 5 tee .claude/settings.json',
    'timeout 5 sed -i s/a/b/ .claude/settings.json', 'timeout 5 rm .claude/settings.json', 'timeout -s KILL 5 mv x .harness.json', 'timeout --kill-after=1 5 cp x .harness.json', 'timeout --kill-after 1 5 cp x .harness.json', 'stdbuf -o0 mv x .claude/settings.json', 'stdbuf -o L cp x .harness.json',
    'ionice cp x .claude/settings.json', 'ionice -c 3 cp x .harness.json', 'flock /tmp/l cp x .claude/settings.json', 'flock -w 5 /tmp/l rm .harness.json', 'flock -n -x /tmp/l cp x .harness.json', 'flock /tmp/l -c "cp x .harness.json"', 'flock -c "rm .harness.json" /tmp/l', 'flock -w5 9 sh -c "echo > .harness.json"',
    'setsid cp x .harness.json', 'setsid -w cp x .harness.json', 'nohup cp x .harness.json', 'env -u FOO cp x .harness.json', 'env FOO="a b" cp x .harness.json', 'command cp x .harness.json', 'sudo -u root nice -n 5 timeout 5 cp x .claude/settings.json', 'time -p cp x .harness.json', 'xargs -n 1 rm .harness.json',
    'exec cp x .harness.json', 'FOO=1 nohup env BAR=2 tee .harness.json', 'sudo sh -c "echo > .harness.json"',
    // <> opens the file for writing too
    'echo 9 1<>.claude/settings.json', 'echo 9 <>.harness.json', 'exec 3<> .claude/settings.json; echo 9 >&3', 'exec 3<>.harness.json', 'cat x 1<> .harness.json',
    // a cd earlier in the command moves the cwd for redirects, tee, sed -i and the rest
    'cd .claude && echo > settings.json', 'cd .claude; tee settings.json < x', 'cd .claude && sed -i s/a/b/ settings.local.json', 'pushd .claude && echo > settings.json', 'cd .claude && rm settings.json', 'cd sub && cd .. && echo x > .harness.json', 'cd ~/.claude && echo x > settings.json', 'cd /x/.claude && echo x > settings.json',
    // one-liners: the policy path is the write target (directly, through a variable, or as either side of a rename)
    `node -e "const p='.harness.json'; require('fs').writeFileSync(p,'{}')"`, `node -e "const fs=require('fs'), p=require('path').join('.claude','settings.json'); fs.writeFileSync(p,'{}')"`, `python3 -c "p='.claude/settings.json'; open(p,'w').write('{}')"`,
    `python3 -c "import os; os.remove('.harness.json')"`, `python3 -c "import os; os.rename('/tmp/x', '.harness.json')"`, `node -e "require('fs').renameSync('.harness.json','/tmp/x')"`, `perl -e 'open(F,">.harness.json"); print F 1'`, `ruby -e 'File.open(".harness.json","w") { |f| f.write("{}") }'`,
    `node -e "fs.writeFileSync('/tmp/a', 1); fs.writeFileSync('.harness.json', '{}')"`, `python3 -c "import os; os.system('echo x > .harness.json')"`, `python3 -c "import subprocess; subprocess.run(['rm', '.claude/settings.json'])"`, `node -e "require('child_process').execSync('rm .harness.json')"`,
    `python3 -c "c='rm .harness.json'; import os; os.system(c)"`, `ruby -e 'File.write ".harness.json", "{}"'`, `python3 -c "from pathlib import Path; p=Path('.claude/settings.json'); p.write_text('{}')"`, `node -e "const fs=require('fs'); fs.writeFileSync('/tmp/a', fs.readFileSync('.harness.json')); fs.unlinkSync('.harness.json')"`,
    `node -e "require('fs').writeFileSync(process.argv[1], '{}')" .harness.json`, `perl -e 'open(my $fh, ">>", ".harness.json"); print $fh 1'`, `python3 -c "open('.harness.json','r+').write('{}')"`, `python3 -c "open('.harness.json', 'w').write('{}')  # don't"`,
  ];
  // Allowed: reads, copies elsewhere, index-only git, and ordinary writes. `echo "> .harness.json is policy" | wc -l` is allowed on purpose: the redirect is inside quotes, so it is text.
  const sid66Allow = [
    'echo x > src/a.ts', 'echo x > settings.json', 'echo x > config/settings.json', 'cat .harness.json', 'jq . .harness.json', 'cp .harness.json /tmp/h.json', 'cp templates/harness.json docs/harness.example.json', 'git add .harness.json',
    'git diff -- .harness.json', 'git log -p -- .harness.json', 'git show origin/main:.harness.json', 'git show origin/main:.harness.json > /tmp/policy.json', 'git rm --cached .harness.json', 'git restore --staged .harness.json',
    'grep -n allowMerge .harness.json', 'sed -n 1p .harness.json', 'sed -i s/a/b/ src/a.ts', "sed -i 's/.*/x/' src/a.ts", 'npm test 2>&1 | tee test.log', 'npm run build > build.log', 'npm run lint', 'npx tsc --noEmit', 'flutter test', 'make',
    'node -e "console.log(1)"', 'python3 -c "print(1)"', `node -e "console.log(require('./.harness.json'))"`, `python3 -c "import json;print(json.load(open('.harness.json')))"`, 'cp -r src/ dist/', 'mv a.txt b.txt', 'rm -f build.log', 'rm .*.swp',
    'ln -s ../lib lib2', 'git checkout main', 'git checkout -- a.txt', 'git restore a.txt', 'git commit -m "update .harness.json docs"', 'echo "> .harness.json is policy" | wc -l', 'vim src/a.ts', 'touch notes.md', 'mkdir -p .claude/commands',
    'rm -rf .claude/commands', 'rm .claude/commands/x.md', 'mkdir -p .claude/agents', 'cp x.md .claude/commands/', 'ls .claude', 'cat .claude/settings.json', 'rm -rf build .cache', 'git checkout -- src', 'rm .claude', 'rm -rf .claudeX', 'cp -r src .claude/agents',
    'cp -r .claude /tmp/claude-backup', 'git rm -r --cached .claude', 'git restore --staged .claude', 'git rm -r src', 'git checkout main -- src', 'mv x.md .claude/commands/', 'cp .harness.json nodir', 'cp settings.json sub', 'cp x.md sub',
    'echo x > .claude/commands/ship.md', "cat > docs/h.md <<'EOF'\nrm .harness.json\necho x > .harness.json\nEOF",
    'nice -n 5 npm test', 'timeout 5 cp .harness.json /tmp/', 'sudo -u root cat .harness.json', 'flock /tmp/l npm test', 'stdbuf -o0 npm test | tee test.log', 'timeout 60 make', 'timeout -s KILL 5 cp a b', 'flock -w 5 /tmp/l -c "npm test"', 'setsid -w make', 'env FOO="a b" npm test', 'ionice -c 3 nice -n 5 cp a b', 'xargs -n 1 rm build.log',
    'cat < .harness.json', 'exec 3< .harness.json', 'exec 3<> /tmp/x', 'wc -l <.claude/settings.json',
    'cd /tmp && echo x > settings.json', 'cd src && echo x > settings.json', 'cd .claude && cat settings.json', 'cd .claude && echo x > commands/a.md', 'cd .claude && cp settings.json /tmp/', 'cd src && sed -i s/a/b/ settings.json',
  ];
  // SID-66 (CTO decision): reading a policy file is never a deny. Copying FROM it (to another place), interpreter one-liners that only read it, and the usual read tools are allowed in both repos. `sub` is an existing directory in the b2 scratch repos.
  const sid66ReadAllow = [
    // copies from a policy file
    'cp .harness.json backup/', 'cp .harness.json /tmp/', 'cp .harness.json /tmp/h.json', 'cp .harness.json sub', 'cp -t sub .harness.json', 'rsync .harness.json sub', 'install .harness.json sub', 'cp x/.harness.json ./sub',
    'cp .claude/settings.json /tmp/', 'cp .claude/settings.json backup/', 'cp .harness.json sub/', 'cp x/settings.json sub', 'cp -t /tmp .harness.json',
    // interpreter one-liners that only read
    `node -e "JSON.parse(require('fs').readFileSync('.harness.json'))"`, `node -e "console.log(JSON.parse(require('fs').readFileSync('.harness.json','utf8')).gate)"`,
    `python -c "import json; json.load(open('.harness.json'))"`, `python3 -c "import json; print(json.load(open('.harness.json', 'r')))"`, `python3 -c "from pathlib import Path; print(Path('.harness.json').read_text())"`,
    `ruby -e "puts File.open('.harness.json').read"`, `node -e "require('fs').copyFileSync('.harness.json', '/tmp/h.json')"`, `python3 -c "import shutil; shutil.copy('.harness.json', '/tmp/h.json')"`,
    // read tools
    'jq . .harness.json', 'jq .gate .harness.json', 'cat .harness.json', 'cat .claude/settings.json', 'grep -n allowMerge .harness.json', 'git diff .harness.json', 'git diff origin/main -- .harness.json', 'git show HEAD:.harness.json',
    'git show origin/main:.claude/settings.json', 'git log -p -- .harness.json', 'git log --oneline -- .claude/settings.json', 'head .harness.json', 'less .harness.json', 'wc -c .harness.json', 'diff .harness.json templates/harness.json', 'cmp .harness.json /tmp/h.json',
    // one-liners that read a policy file and write somewhere else, or only mention its name
    `python3 -c "import json; d=json.load(open('.harness.json')); open('/tmp/out.json','w').write(json.dumps(d))"`, `node -e "const fs=require('fs'); fs.writeFileSync('/tmp/x.json', fs.readFileSync('.harness.json'))"`,
    `node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync('.claude/settings.json','utf8')); fs.writeFileSync('/tmp/s.json', JSON.stringify(d))"`, `python3 -c "print('edit .claude/settings.json by hand'); open('/tmp/log','w').write('x')"`,
    `node -e "console.log('.harness.json'); require('fs').writeFileSync('/tmp/a','b')"`, `ruby -e 'puts File.read(".harness.json"); File.write("/tmp/x", "y")'`, `python3 -c "import shutil; shutil.copy('.harness.json', '/tmp/h.json'); open('/tmp/n','w').write('1')"`,
    `python3 -c "from pathlib import Path; p=Path('.harness.json'); Path('/tmp/o').write_text(p.read_text())"`, `python3 -c "import subprocess; subprocess.run(['cat', '.harness.json'])"`, `node -e "const p='.harness.json'; const d=require('fs').readFileSync(p); require('fs').writeFileSync('/tmp/o', d)"`,
  ];
  try {
    // a + b. every write form is denied with and without a committed policy, and says what to do; ordinary commands are not touched
    const none = mkNone('none');
    for (const [label, d] of [['no policy', none], ['committed policy', repo]]) {
      for (const c of sid66Deny) {
        const v = verdict(d, c);
        assert.ok(v.deny, `${label}: must deny: ${c}`);
        const head = v.why.split('\n  in:')[0];
        if (/settings|\.claude/.test(c)) assert.match(head, /holds Claude Code permissions.*ask the human/, `${label}: ${c}`);
        else { assert.match(head, /is the harness policy; agents do not write it/, `${label}: ${c}`); assert.match(head, /templates\/harness\.json/, c); assert.match(head, /git fetch origin/, c); }
        assert.match(v.why, /policy: /, `${label}: policyNote on ${c}`);
      }
      for (const c of sid66Allow) assert.ok(!verdict(d, c).deny, `${label}: must allow: ${c} (${verdict(d, c).why})`);
    }

    // b2. a policy-named source copied into a DIRECTORY (trailing slash, ., .., -t, or an existing directory) lands as dir/<name>. That is a read of the policy unless it lands on the REPO-ROOT .harness.json or on a .claude/settings*.json. Resolved against the event cwd in pre-bash.
    for (const [label, d] of [['no policy', none], ['committed policy', repo]]) {
      mkdirSync(join(d, 'sub'), { recursive: true });
      const hadClaude = existsSync(join(d, '.claude'));
      mkdirSync(join(d, '.claude'), { recursive: true });
      try {
        for (const c of sid66ReadAllow) assert.ok(!verdict(d, c).deny, `${label}: must allow (sid66ReadAllow): ${c} (${verdict(d, c).why})`);
        const inSub = (c) => { const r = run('pre-bash.mjs', bash(c, join(d, 'sub'))); return { deny: r?.hookSpecificOutput?.permissionDecision === 'deny', why: reasonOf(r) }; };
        // from a subdirectory cwd, `..` is the repo root; the same copy that is fine at the root is a root-policy write here
        const up = inSub('cp ../x/.harness.json ..');
        assert.ok(up.deny, `${label}: from sub, cp ../x/.harness.json .. lands on the root policy`);
        assert.match(up.why, /\.\.\/\.harness\.json is the harness policy; agents do not write it.*\n  \("\.\." is an existing directory, so this writes \.\.\/\.harness\.json\)/s, `${label}: message`);
        assert.ok(inSub('cp ../x/.harness.json ../').deny && inSub('cp -t .. x/.harness.json').deny, `${label}: from sub, ../ and -t .. land on the root policy`);
        assert.ok(inSub('cd .. && cp x/.harness.json .').deny, `${label}: a cd in the same command is followed`);
        for (const c of ['cp .harness.json .', 'cp x/.harness.json ./', 'cp ../.harness.json .', 'cp .harness.json ../backup/', 'cp x/settings.json .']) assert.ok(!inSub(c).deny, `${label}: from sub, must allow: ${c} (${inSub(c).why})`);
        for (const c of ['cp x/settings.json .claude', 'cp x/settings.json .claude/', 'cp x/settings.local.json sub/../.claude']) assert.match(verdict(d, c).why, /ask the human/, `${label}: ${c}`);
        for (const c of ['cp x/.harness.json .', 'cp x/.harness.json ./', 'cp -t . x/.harness.json', 'rsync x/.harness.json .', 'install x/.harness.json .']) assert.match(verdict(d, c).why, /\.harness\.json is the harness policy/, `${label}: ${c}`);
        for (const c of ['cp .harness.json nodir', 'cp .harness.json sub2', 'cp settings.json sub', 'cp x.md sub']) assert.ok(!verdict(d, c).deny, `${label}: must allow: ${c}`);
        for (const c of ['cp a sub/.harness.json', 'cp a sub/.claude/settings.json', 'echo x > sub/.harness.json']) assert.ok(verdict(d, c).deny, `${label}: explicit policy-named destination stays denied: ${c}`);
      } finally {
        if (!hadClaude) rmSync(join(d, '.claude'), { recursive: true, force: true });
      }
    }

    // c. the issue's repro: the heredoc is refused; even if a human or another route lands an untracked .harness.json, it grants nothing (SID-65)
    const c = mkNone('c');
    assert.ok(verdict(c, "cat > .harness.json <<'J'\n{\"allowMerge\":true}\nJ").deny, 'c: heredoc write refused');
    assert.ok(!existsSync(join(c, '.harness.json')), 'c: the hook never writes');
    writeFileSync(join(c, '.harness.json'), JSON.stringify({ allowMerge: true }));
    assert.match(verdict(c, 'gh pr merge 1').why, /merging or closing a PR/, 'c: a successful bypass still grants nothing');

    // d. a write through an existing symlink to a policy file is refused
    const d = mkNone('d');
    writeFileSync(join(d, '.harness.json'), '{}');
    sh(d, 'ln -s .harness.json p && ln -s nowhere dangling && echo y > q');
    const vd = verdict(d, 'echo x > p');
    assert.ok(vd.deny, 'd: write through a symlink to .harness.json denied');
    assert.match(vd.why, /p is a symlink to .*\.harness\.json is the harness policy/);
    assert.ok(verdict(d, 'tee -a p').deny && verdict(d, 'cp a p').deny, 'd: tee and cp through the symlink denied');
    for (const ok of ['echo x > q', 'echo x > dangling', 'cat p', 'rm p']) assert.ok(!verdict(d, ok).deny, `d: must allow: ${ok}`);
    // sed -i and perl -i / ruby -i write through a link too
    mkdirSync(join(d, '.claude'), { recursive: true });
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), '{}');
    writeFileSync(join(d, 'src/a.ts'), 'a');
    sh(d, 'ln -s .claude/settings.json link.json && ln -s .harness.json link2.json');
    for (const c of ['sed -i s/a/b/ link.json', 'sed -i s/a/b/ link2.json', 'perl -pi -e s/a/b/ link.json', 'ruby -pi -e 1 link2.json', 'cd src && sed -i s/a/b/ ../link.json']) {
      const v = verdict(d, c);
      assert.ok(v.deny, `d: must deny through a symlink: ${c}`);
      assert.match(v.why, /is a symlink to .*(settings\.json holds Claude Code permissions|\.harness\.json is the harness policy)/s, `d: ${c}`);
    }
    for (const ok of ['sed -i s/a/b/ src/a.ts', 'sed -n 1p link.json', 'perl -pi -e s/a/b/ src/a.ts']) assert.ok(!verdict(d, ok).deny, `d: must allow: ${ok}`);

    // e. policy.mjs (Edit/Write/MultiEdit): same files, new message; other files untouched
    const home = (await import('node:os')).homedir();
    for (const tool of ['Edit', 'Write', 'MultiEdit'])
      for (const [f, re] of [[join(repo, '.harness.json'), /templates\/harness\.json.*git fetch origin/], [join(repo, '.claude/settings.json'), /ask the human/], [join(repo, '.claude/settings.local.json'), /ask the human/], ['./.harness.json', /templates\/harness\.json/], [join(home, '.claude/settings.json'), /ask the human/]]) {
        const r = run('policy.mjs', { tool_name: tool, tool_input: { file_path: f }, cwd: repo });
        assert.equal(r?.hookSpecificOutput?.permissionDecision, 'deny', `${tool} ${f}`);
        assert.match(reasonOf(r), re, `${tool} ${f}`);
      }
    for (const f of ['.claude/commands/x.md', 'src/settings.json', 'docs/harness.json'])
      assert.ok(!denied('policy.mjs', { tool_name: 'Write', tool_input: { file_path: join(repo, f) }, cwd: repo }), `policy allows ${f}`);
  } finally {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
    rmSync(join(repo, 'sub'), { recursive: true, force: true });
  }
}

// SessionStart hook: valid additionalContext JSON naming the router and the Read-by-path rule; fails open on garbage input.
for (const input of [JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }), 'not json', '']) {
  const out = JSON.parse(execFileSync('node', [join(hooks, 'session-start.mjs')], { input, cwd: tmpdir() }).toString());
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /`sflow:sflow`/, 'names the model-invocable router');
  assert.match(ctx, /skills.<name>.SKILL\.md/, 'says to read pstack skills by path');
  assert.doesNotMatch(ctx, /pstack:/, 'no pstack:* namespace the Skill tool cannot resolve');
  assert.ok(existsSync(join(hooks, '..', '..', 'skills', 'sflow', 'SKILL.md')), 'the router it names exists');
}
const startEntry = JSON.parse(readFileSync(join(hooks, '..', 'hooks.json'), 'utf8')).hooks.SessionStart;
assert.equal(startEntry.length, 1, 'exactly one SessionStart entry');
assert.match(startEntry[0].hooks[0].command, /hooks\/harness\/session-start\.mjs/);
console.log('hooks ok');
