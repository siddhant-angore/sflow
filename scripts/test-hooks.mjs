// Pipes sample events through each hook and asserts the decision. Run: node scripts/test-hooks.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
];
for (const c of mustDeny) assert.ok(denied('pre-bash.mjs', bash(c)), `must deny: ${c}`);

const mustAllow = [
  'git push -u origin feat/x', 'git push', 'git push origin HEAD', 'git push --force-with-lease=feat/x:abc origin feat/x', 'git push origin sid-12-fix-main-nav', 'git push -u origin feat/main-menu',
  'git push -u origin sid-7-master-detail-view', 'git status', 'git branch -d x', 'git checkout -- a.txt', 'git restore a.txt', 'git checkout main', 'git stash', 'git stash pop', 'git commit -m "no -n here"',
  'git commit --amend --no-edit', 'git rebase main', 'gh pr create --fill', 'gh pr view 1', 'gh api repos/o/r/pulls/1', 'ls -fd', 'grep -r "git push -f" docs', 'echo "do not git push -f"', 'npm run publish-docs', 'git reset a.txt', 'git reset --soft HEAD~1', 'git clean -n',
];
for (const c of mustAllow) assert.ok(!denied('pre-bash.mjs', bash(c)), `must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);

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

    // h. remote-tracking refs locate the policy, so local rewrites are refused
    for (const cmd of ['git remote set-head origin feat/x', 'git remote set-head origin -d', 'git remote set-head origin --delete', 'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feat/x',
      'git symbolic-ref -d refs/remotes/origin/HEAD', 'git update-ref refs/remotes/origin/main HEAD', 'git fetch origin feat/x:refs/remotes/origin/main', 'git fetch origin +feat/x:refs/remotes/origin/main', "git fetch origin 'feat/x:refs/remotes/origin/main'"]) {
      const v = verdict(a, cmd);
      assert.ok(v.deny, `h: must deny: ${cmd}`);
      assert.match(v.why, /remote-tracking refs locate the harness policy; rewriting them locally is not allowed \(git fetch updates them\)/, cmd);
    }
    for (const cmd of ['git config remote.origin.fetch +refs/heads/x:refs/remotes/origin/main', "git config remote.origin.fetch '+refs/heads/x:refs/remotes/origin/main'", 'git config --add remote.origin.fetch +refs/heads/x:refs/remotes/origin/main',
      'git config --replace-all remote.origin.fetch +refs/heads/x:refs/remotes/origin/main', 'git config --unset remote.origin.fetch', 'git config --unset-all remote.origin.fetch', 'git config --global remote.origin.fetch x', 'git config set remote.origin.fetch x']) {
      const v = verdict(a, cmd);
      assert.ok(v.deny, `h: must deny: ${cmd}`);
      assert.match(v.why, /remote-tracking refs locate the harness policy/, cmd);
    }
    for (const cmd of ['git -c remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main fetch', "git -c 'remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main' fetch origin",
      'git --config-env=remote.origin.fetch=FETCHSPEC fetch', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.fetch GIT_CONFIG_VALUE_0=x git fetch', "GIT_CONFIG_PARAMETERS=\"'remote.origin.fetch=x'\" git fetch"]) {
      const v = verdict(a, cmd);
      assert.ok(v.deny, `h: must deny: ${cmd}`);
      assert.match(v.why, /remote-tracking refs locate the harness policy; rewriting them locally is not allowed \(git fetch updates them\)/, cmd);
    }
    for (const cmd of ['gh repo edit --default-branch feat/x', 'gh repo edit o/r --description x']) {
      const v = verdict(a, cmd);
      assert.ok(v.deny, `h: must deny: ${cmd}`);
      assert.match(v.why, /repo lifecycle and settings, secrets, and workflow triggers are human actions/, cmd);
    }
    for (const cmd of ['git config --get remote.origin.fetch', 'git config --get-all remote.origin.fetch', 'git config -l', 'git config --list', 'git config remote.origin.fetch', 'git config get remote.origin.fetch', 'git config user.name x', 'gh repo view', 'git -c color.ui=never fetch origin', 'git -c http.lowSpeedLimit=1 fetch'])
      assert.ok(!verdict(a, cmd).deny, `h: must allow: ${cmd}`);
    for (const cmd of ['git remote set-head origin --auto','git remote set-head origin -a', 'git symbolic-ref --short refs/remotes/origin/HEAD', 'git symbolic-ref HEAD', 'git fetch', 'git fetch origin', 'git fetch -q origin main', 'git remote -v'])
      assert.ok(!verdict(a, cmd).deny, `h: must allow: ${cmd}`);

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
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
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
