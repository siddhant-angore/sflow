// Pipes sample events through each hook and asserts the decision. Run: node scripts/test-hooks.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { segments as newSegments } from '../hooks/harness/lib.mjs';
import * as newRules from '../hooks/harness/guard-rules.mjs';

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
const corpus = new Set(); // every command sent through bash(), reused by the regression check
const bash = (command, cwd = repo) => (corpus.add(command), { tool_name: 'Bash', tool_input: { command }, cwd });

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

// SID-79/80: global git options, wrappers, paths, grouping, and HEAD/@ on a protected branch. The repo is on feat/x with a clean tree.
const rawPrefixes = ['git -P', 'git -p', 'git --paginate', 'git --no-pager', 'git --no-replace-objects', 'git --literal-pathspecs', 'git -c a=b -C .', 'git --git-dir=.git', 'git --work-tree .', 'env git', 'env GIT_PAGER=cat git', 'env -i PATH=/usr/bin git',
  'command git', 'exec git', 'nice -n 5 git', 'nohup git', 'time git', 'timeout 10 git', 'sudo git', 'GIT_PAGER=cat git', '/usr/bin/git', './git', '../bin/git', '\\git', '\\/usr/bin/git', '(git', '$(git', '{ git', 'if git'];
const closeShell = (pre, c) => (pre === '(git' || pre === '$(git' ? `${c})` : pre === '{ git' ? `${c} ; }` : pre === 'if git' ? `${c}; then :; fi` : c);
for (const pre of rawPrefixes)
  for (const body of ['push --force origin main', 'push origin HEAD:main', 'reset --hard', 'branch -D feat/evil', 'clean -fdx', 'checkout .', 'push --mirror', 'filter-branch --all']) {
    const c = closeShell(pre, `${pre} ${body}`);
    assert.ok(denied('pre-bash.mjs', bash(c)), `SID-79 must deny: ${c}`);
  }
for (const c of ['env gh pr merge 1', '/usr/local/bin/gh pr merge 1', '\\gh release create v1', 'env npm publish']) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-79 must deny: ${c}`);
for (const [pre, body, why] of [['git -P', 'push --force origin main', /force push/], ['git --paginate', 'push --force origin main', /force push/], ['env git', 'push --force origin main', /force push/], ['command git', 'push --force origin main', /force push/], ['/usr/bin/git', 'push --force origin main', /force push/], ['\\git', 'push --force origin main', /force push/],
  ['git -P', 'reset --hard', /git reset --hard/], ['git --paginate', 'reset --hard', /git reset --hard/], ['env git', 'reset --hard', /git reset --hard/], ['command git', 'reset --hard', /git reset --hard/], ['/usr/bin/git', 'reset --hard', /git reset --hard/], ['\\git', 'reset --hard', /git reset --hard/],
  ['git -P', 'branch -D feat/evil', /force-deleting/], ['git -P', 'push origin HEAD:main', /protected branch/]])
  assert.match(reasonOf(run('pre-bash.mjs', bash(`${pre} ${body}`))), why, `SID-79 reason: ${pre} ${body}`);
assert.match(reasonOf(run('pre-bash.mjs', bash('git reset --hard'))), /commit to a WIP branch.*git restore <path>/, 'reset message says what to do instead');
for (const c of ['git -P log', 'git -p log', 'git --no-pager diff', 'git --paginate show HEAD', 'env GIT_PAGER=cat git log', 'env FOO=1 git status', 'command git diff', '/usr/bin/git status', '\\git status', 'git -C . status', 'git -C sub status', 'git -c color.ui=never log --oneline',
  'git push origin HEAD', 'git push -u origin HEAD', 'git push origin feat/x 2>&1', 'git push -o ci.skip origin feat/x', 'git push origin HEAD > /dev/null', 'git push -u origin HEAD 2>&1 | tail -1', 'git push origin @', 'git push origin HEAD:feat/x', 'nice git log', 'timeout 30 git fetch origin', '(cd sub && git status)', 'echo $(git rev-parse HEAD)', 'gitk --all', './scripts/git-helper push -f', 'echo "git -P push -f"', 'grep -rn "env git push --force" docs', 'ls -la'])
  assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-79/80 must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin $(git branch --show-current)'))), /literal/, 'command substitution in push arguments stays denied');
// Redirections before the arguments must not hide flags or refspecs; splitting is quote-aware; sh -c / eval payloads are checked.
for (const [c, why] of [['git push 2>&1 origin HEAD:main', /protected branch/], ['git push 2>&1 origin feat/x:main', /protected branch/], ['git push &>/dev/null origin HEAD:main', /protected branch/], ['git push >&2 origin HEAD:main', /protected branch/],
  ['git push 2>/dev/null origin feat/x:main', /protected branch/], ['git push 2>&1 origin :main', /deletion/], ['git push >&2 origin :main', /deletion/], ['git push 2>&1 -f origin feat/x', /force push/], ['git push >/dev/null 2>&1 --force origin feat/x', /force push/],
  ['git push 2>&1 --mirror', /mirror/], ['git push &>/dev/null --mirror', /mirror/], ['git reset 2>&1 --hard', /git reset --hard/], ['git reset >/dev/null --hard', /git reset --hard/], ['git branch 2>&1 -D x', /force-deleting/], ['git branch &>/dev/null -D x', /force-deleting/],
  ['git clean 2>&1 -fdx', /git clean/], ['git clean 2> err.log -fdx', /git clean/], ['git checkout 2>&1 .', /discarding/], ['git checkout >&2 .', /discarding/], ['git commit 2>&1 --no-verify -m x', /no-verify/], ['git commit 2>&1 -n -m x', /no-verify/],
  ['gh api 2>&1 -X PUT repos/o/r/pulls/1/merge', /GitHub API/], ['gh api >&2 -X PUT repos/o/r/pulls/1/merge', /GitHub API/], ['git push origin feat/x 2>&1 & git push 2>&1 origin feat/x:main', /protected branch/],
  ['2>/dev/null git push -f origin feat/x', /force push/], ['>/dev/null git reset --hard', /git reset --hard/], ['git -C . 2>&1 push -f origin feat/x', /force push/], ['git push origin HEAD>/dev/null -f', /force push/],
  ['bash -c "true; git push -f origin main"', /force push/], ["sh -c 'cd x && git reset --hard'", /git reset --hard/], ['bash -lc "git push origin HEAD:main"', /protected branch/], ['eval "git push --force"', /force push/], ['eval git reset --hard', /git reset --hard/],
  ['ssh host "cd x; git push -f origin main"', /force push/], ['su -c "cd x && git reset --hard" me', /git reset --hard/], ['watch "true; git reset --hard"', /git reset --hard/], ['script -c "true; git push -f" /dev/null', /force push/], ['flock /tmp/l -c "true; git push -f"', /force push/],
  ['echo "$(git push -f)"', /force push/], ['git push origin $(git branch --show-current)', /literal/]])
  assert.match(reasonOf(run('pre-bash.mjs', bash(c))), why, `SID-79 must deny: ${c}`);
for (const c of ['git commit -m "fix (git push -f) docs"', 'echo "{ git push }"', "echo 'a & b'", 'echo "a && git push -f"', "git commit -m 'x; git reset --hard'", 'git log --format="%h (%s)"', 'git push origin feat/x 2>&1', 'git push -u origin HEAD 2>&1 | tail -1', 'git log 2>&1 | head',
  'sleep 1 & git status', 'echo "\\"quoted\\" (paren)"', 'bash -c "git status"', "echo '$(git push -f)'", 'git status 2>&1 & git log', 'echo "a" > out.txt', 'git log >/dev/null 2>&1; git status',
  "git push origin feat/x # don't push main", 'git status # reset --hard later', 'ssh host "git status"', 'watch git status', 'su -c "git log" me'])
  assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-79 must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);

// SID-80: on a protected branch HEAD and @ are that branch.
sh(repo, 'git checkout -q main');
for (const c of ['git push origin HEAD', 'git push origin @', 'git push -u origin HEAD', 'git push origin HEAD:HEAD', 'git push origin @:main', 'git push origin', 'git push -u origin', 'git -P push origin HEAD', 'env git push origin @']) {
  const why = reasonOf(run('pre-bash.mjs', bash(c)));
  assert.ok(denied('pre-bash.mjs', bash(c)), `SID-80 must deny on main: ${c}`);
  assert.match(why, c === 'git push origin @:main' ? /protected branch/ : /protected branch main/, `SID-80 reason: ${c}`); // @:main names main in the text, so it keeps the existing "direct push to a protected branch (main, master)" message
  assert.match(why, /feature branch/, `SID-80 says what to do: ${c}`);
}
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin HEAD'))), /^harness guard: HEAD\/@ here is protected branch main; create a feature branch \(git switch -c <name>\)/);
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin +HEAD'))), /\+ refspec/);
for (const c of ['git push origin 2>&1', 'git push origin > /dev/null', 'git push origin >/dev/null 2>&1', 'git push origin 2>/dev/null', 'git push -o ci.skip origin', 'git push --push-option ci.skip origin', 'git push --repo origin', 'git push --receive-pack git-receive-pack origin', 'git push --exec x origin'])
  assert.match(reasonOf(run('pre-bash.mjs', bash(c))), /protected branch main; create a feature branch and push that/, `SID-80 redirection/option arg: ${c}`);
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin HEAD > /dev/null'))), /feature branch/, 'HEAD with redirection still denied');
for (const c of ['git push 2>&1 origin', 'git push >/dev/null origin', 'git push > /dev/null origin', 'git push origin HEAD>/dev/null', '2>&1 git push origin', 'git push origin 2>&1 & git status'])
  assert.ok(denied('pre-bash.mjs', bash(c)), `SID-80 must deny on main: ${c}`);
sh(repo, 'git checkout -q --detach');
assert.ok(!denied('pre-bash.mjs', bash('git push origin HEAD')), 'detached HEAD is not a protected push (git refuses it)');
assert.ok(denied('pre-bash.mjs', bash('git push origin HEAD:main')), 'detached HEAD:main is still denied by the destination');
sh(repo, 'git checkout -q feat/x');

// SID-79 review: $'..', heredoc bodies, line continuation, and launchers that only the quote-blind scan on main caught.
const L = (...lines) => lines.join('\n');
const classA = [String.raw`echo $'\''; git push -f origin main`, String.raw`echo $'\''; git push -f origin main; echo \'`, String.raw`printf '%s' $'it\'s'; git reset --hard`];
const classB = [L('cat <<EOF', "it's", 'EOF', 'git push -f origin main'), L('cat > f <<EOF', "don't", 'EOF', 'git push -f origin main'), L("cat <<'EOF'", "it's", 'EOF', 'git push -f origin main'), L('cat <<"EOF"', "it's", 'EOF', 'git push -f origin main'),
  L('cat <<-EOF', "\tit's", '\tEOF', 'git push -f origin main'), L('cat <<EOF', "it's", 'EOF', 'git push -f origin main', "echo don't"), L("bash <<'E'", 'sleep 1 & git push -f origin main', 'E'), L('cat <<EOF | sh', 'git push -f origin main', 'EOF'), L('cat <<EOF | sh', 'sleep 1 & git push -f origin main', 'EOF'),
  L('cat <<EOF', '$(git push -f origin main)', 'EOF'), L("ssh host <<'E'", 'git reset --hard', 'E'),
  L('cat <<EOF', "it's", 'EOF', 'sleep 1 & git push -f origin main'), L('cat << EOF', "it's", 'EOF', '(git push -f origin main)'), L('cat <<E"OF"', "it's", 'EOF', 'sleep 1 & git push -f origin main'), L('cat <<\\EOF', "it's", 'EOF', 'sleep 1 & git push -f origin main'),
  L('cat <<A <<B', "it's", 'A', "don't", 'B', 'sleep 1 & git push -f origin main'), L('cat <<EOF', 'git push -f origin main'), L('cat <<EOF', "it's", 'git push -f origin main'), L('busybox sh <<E', 'sleep 1 & git reset --hard', 'E'), L('cat <<EOF', '`git push -f origin main`', 'EOF')];
const classBAllow = [L("cat > notes.md <<'EOF'", "Don't run git push -f origin main; it's blocked", 'EOF'), L('cat <<EOF', "it's (fine) & ok; really", 'EOF', 'git status'), L("git commit -F - <<'EOF'", "fix: don't (git push -f) here", 'EOF'),
  L("cat <<'EOF'", '$(git push -f origin main)', 'EOF'), L('cat <<EOF', 'x', 'EOF', 'git status'),
  L('git commit -m "$(cat <<\'EOF\'', "fix: it's (git push -f) ok; really", 'EOF', ')"'), L('git add -A && git commit -m "$(cat <<\'EOF\'', "fix: don't; git reset --hard", 'EOF', ')"'),
  L('gh pr create --title t --body "$(cat <<\'EOF\'', '## Summary', "- don't git push -f; ok", 'EOF', ')"')];
const classC = [L('git push -f \\', ' origin main'), L('git push \\', ' origin main'), L('git reset \\', ' --hard'), L('git branch \\', ' -D x'), L('gh api \\', ' -X PUT repos/o/r/pulls/1/merge'), L("git push 'a", "b' -f origin main")];
const classCAllow = [L('git log \\', ' --oneline'), L('git push \\', ' origin feat/x')];
const classD = ["setsid sh -c 'true; git push -f origin main'", "bash -c -- 'true; git push -f origin main'", `perl -e 'system("true; git push -f origin main")'`, "tmux new 'true; git push -f origin main'", "busybox sh -c 'true; git push -f origin main'", "fish -c 'true; git push -f origin main'",
  "docker exec c sh -c 'true; git push -f origin main'", "parallel ::: 'true; git push -f origin main'", "echo 'x; git push -f origin main' | sh", "echo 'x; git push -f origin main' > f.sh && bash f.sh", "git -c core.pager='true; git push -f origin main' log",
  "GIT_PAGER='true; git push -f origin main' git log", "git fetch --upload-pack='x; git reset --hard' origin", "git push --exec='x; git reset --hard' origin feat/x", "git push --receive-pack='true; git push -f origin main' origin feat/x",
  "git push --exec 'x; git reset --hard' origin feat/x", "sort --compress-program='x; git reset --hard' f", "bash -c -- 'git push -f origin main'", "bash -c -x 'git push -f origin main'", "echo 'x; git push -f origin main",
  "git fetch --upl='true; git reset --hard; git-upload-pack' origin", "git fetch --upload-pac='true; git reset --hard' origin", "git fetch --upload='true; git reset --hard' origin", "git fetch --upl 'true; git reset --hard' origin",
  "git push --exe='true; git reset --hard' origin feat/x", "git push --exe 'true; git reset --hard' origin feat/x", "git push --receive='true; git branch -D main' origin feat/x", "git push --receive-p='true; git branch -D main' origin feat/x",
  "git push --rec 'true; git branch -D main' origin feat/x", "git push '--receive-p=true; git branch -D main' origin feat/x", "sort --com='x; git reset --hard' f", "sort --compress 'x; git reset --hard' f",
  `git fetch "--"upl='true; git reset --hard' origin`, `git fetch --u''pl='true; git reset --hard' origin`, `git push -"-"exe='true; git reset --hard' origin feat/x`, `git push $'--rec'eive-p='true; git branch -D main' origin feat/x`,
  String.raw`git push --re\ceive-p='true; git branch -D main' origin feat/x`, `git fetch --u$(echo)pl='true; git reset --hard' origin`, "git fetch --u`echo`pl='true; git reset --hard' origin", "git fetch --u${X}pl='true; git reset --hard' origin", "git fetch -$X-upl='true; git reset --hard' origin"];
const classAAllow = [String.raw`echo $'it\'s ok'`, String.raw`echo $'a\nb'`];
for (const c of [...classA, ...classB, ...classC, ...classD]) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-79 review must deny: ${JSON.stringify(c)}`);
for (const c of [...classAAllow, ...classBAllow, ...classCAllow]) assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-79 review must allow: ${JSON.stringify(c)} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);

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
// Regression check: the quote-aware guard must not allow anything the quote-blind guard on main denied, except the allowlist. Corpus: every command sent through bash() above plus a generated body x template set.
const here = dirname(fileURLToPath(import.meta.url)), gitHere = (...a) => execFileSync('git', ['-C', here, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const baseRev = ['086c230', 'origin/main'].find((r) => { try { gitHere('rev-parse', '--verify', '-q', `${r}^{commit}`); return true; } catch { return false; } });
assert.ok(baseRev, 'regression check needs history: neither 086c230 nor origin/main exists here; fetch full history (git fetch --unshallow origin main)');
const baseSha = gitHere('rev-parse', '--short', baseRev), baseDir = mkdtempSync(join(tmpdir(), 'harness-main-'));
for (const f of ['lib.mjs', 'guard-rules.mjs']) writeFileSync(join(baseDir, f), gitHere('show', `${baseRev}:workflows/hooks/${f}`));
const [oldLib, oldRules] = await Promise.all(['lib.mjs', 'guard-rules.mjs'].map((f) => import(pathToFileURL(join(baseDir, f)).href)));
const guardCfg = { protectedBranches: ['main', 'master'], allowMerge: false };
const oldDenies = (c, b) => Boolean(oldRules.envReason(c) || oldLib.segments(c).some((s) => oldRules.reason(s, guardCfg, b)));
const newDenies = (c, b) => Boolean(newRules.envReason(c) || newSegments(c).some((s) => newRules.reason(s, guardCfg, b)));
const BODIES = ['git push -f origin main', 'git push origin main', 'git push origin HEAD:main', 'git push --mirror', 'git reset --hard', 'git branch -D x', 'git clean -fdx', 'git checkout .', 'git commit --no-verify -m x', 'git stash clear', 'gh pr merge 1', 'gh api -X PUT repos/o/r/pulls/1/merge', 'npm publish'];
const TEMPLATES = [(x) => x, (x) => `true; ${x}`, (x) => `bash -c 'true; ${x}'`, (x) => `bash -c "true && ${x}"`, (x) => `bash -c -- 'true; ${x}'`, (x) => `sh -c '${x}'`, (x) => `setsid sh -c 'true; ${x}'`, (x) => `busybox sh -c 'true; ${x}'`, (x) => `fish -c 'true; ${x}'`,
  (x) => `docker exec c sh -c 'true; ${x}'`, (x) => `tmux new 'true; ${x}'`, (x) => `perl -e 'system("true; ${x}")'`, (x) => `parallel ::: 'true; ${x}'`, (x) => `xargs sh -c 'true; ${x}'`, (x) => `ssh host 'cd x; ${x}'`, (x) => `nohup sh -c 'true; ${x}'`,
  (x) => String.raw`echo $'\''; ${x}`, (x) => String.raw`echo $'a\'b' && ${x}`, (x) => String.raw`echo $'\''; ${x}; echo \'`,
  (x) => L('cat <<EOF', "it's", 'EOF', x), (x) => L('cat > f <<EOF', "don't", 'EOF', x), (x) => L("cat <<'EOF'", "it's", 'EOF', x), (x) => L('cat <<-EOF', "\tit's", '\tEOF', x), (x) => L('bash <<E', x, 'E'), (x) => L('cat <<EOF | sh', x, 'EOF'), (x) => L('cat <<EOF', `$(${x})`, 'EOF'),
  (x) => x.replace(/ (\S+)$/, ' \\\n $1'), (x) => `echo "true; ${x}" | sh`, (x) => `echo 'true; ${x}' > f.sh && bash f.sh`, (x) => `git -c core.pager='true; ${x}' log`, (x) => `GIT_PAGER='true; ${x}' git log`, (x) => `echo "$(${x})"`, (x) => `${x} 2>&1`, (x) => `2>&1 ${x}`,
  (x) => `git fetch --upl='true; ${x}' origin`, (x) => `git push --receive-p='true; ${x}' origin feat/x`, (x) => `git push --exe 'true; ${x}' origin feat/x`, (x) => `sort --com='x; ${x}' f`];
const generated = BODIES.flatMap((b) => TEMPLATES.map((t) => t(b)));
const everything = [...new Set([...corpus, ...generated])];
// Each entry is a command main denied only because it scans quoted text, and the new guard allows because nothing in the command can run that text.
const ALLOWLIST = new Map([
  ['echo "a && git push -f"', 'quoted text of echo, which runs nothing'],
  ["git commit -m 'x; git reset --hard'", 'quoted text of git commit -m'],
  ["git push origin feat/x # don't push main", 'a real comment, never run'],
  [L('git add -A && git commit -m "$(cat <<\'EOF\'', "fix: don't; git reset --hard", 'EOF', ')"'), 'quoted-delimiter heredoc data of cat inside git commit -m; every segment is git add, git commit or cat, none runs it'],
  [L('git push \\', ' origin feat/x'), 'line continuation: it is `git push origin feat/x`; main saw a bare `git push \\` and denied it on the protected branch'],
]);
const rows = everything.flatMap((c) => ['feat/x', 'main'].map((b) => ({ c, b, was: oldDenies(c, b), now: newDenies(c, b) })));
const lost = rows.filter((r) => r.was && !r.now);
assert.deepEqual([...new Set(lost.filter((r) => !ALLOWLIST.has(r.c)).map((r) => r.c))], [], `regression vs ${baseSha}: main denied these, the new guard allows them`);
for (const [c, why] of ALLOWLIST) {
  assert.ok(everything.includes(c), `stale ALLOWLIST entry (not in the corpus): ${c} (${why})`);
  assert.ok(lost.some((r) => r.c === c), `stale ALLOWLIST entry (main does not deny it, or the new guard denies it): ${c} (${why})`);
}
const gaps = rows.filter((r) => generated.includes(r.c) && !r.now);
assert.deepEqual(gaps.filter((r) => r.was).map((r) => `${r.b}: ${r.c}`), [], 'a generated body x template that main denied must stay denied');
console.log(`regression vs ${baseSha}: ${everything.length} commands x 2 branches, main denies ${rows.filter((r) => r.was).length}, new allows ${lost.length} (all allowlisted)`);
console.log(`generated ${generated.length} combinations x 2 branches: new denies all but ${gaps.length} that main also allows`);

console.log('hooks ok');
