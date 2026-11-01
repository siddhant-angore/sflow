// Pipes sample events through each hook and asserts the decision. Run: node scripts/test-hooks.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GATE_RECORD_DIR, gitWrites as newGitWrites, pathWithin, pushSecretScan, secretsInDiff, segments as newSegments, writesFile } from '../hooks/harness/lib.mjs';
import * as newRules from '../hooks/harness/guard-rules.mjs';
import { scratch as makeScratch, trackScratch } from './scratch.mjs';
import { COLLATERAL as sid243Collateral, MUST_ALLOW as sid243Allow, MUST_DENY_ATTR, MUST_DENY_CONFIG, MUST_DENY_OPAQUE, MUST_DENY_OVERRIDE, MUST_DENY_WRAPPER, NESTED_QUOTE_VARIANTS, QUOTE_VARIANTS, WRAP_VARIANTS } from './sid243-cases.mjs';

const hooks = new URL('../hooks/harness/', import.meta.url).pathname;
const run = (hook, ev) => {
  const out = execFileSync('node', [join(hooks, hook)], { input: JSON.stringify(ev), cwd: ev.cwd, timeout: 120_000 }).toString().trim();
  return out ? JSON.parse(out) : null;
};
const sh = (cwd, c) => execFileSync('sh', ['-c', c], { cwd, stdio: 'pipe', timeout: 120_000, maxBuffer: 1 << 26 }).toString().trim();
const TOKEN = 'AKIA' + 'ABCDEFGHIJKLMNOP'; // built at run time, so this file holds no secret-shaped text
const reasonOf = (r) => r?.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (hook, ev) => run(hook, ev)?.hookSpecificOutput?.permissionDecision === 'deny';

// A repo with an origin whose main carries the policy, and a feature branch checked out.
const repo = makeScratch('harness-test-');
sh(repo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init');
writeFileSync(join(repo, '.harness.json'), JSON.stringify({ gate: ['test -f a', 'echo base={base}'] }));
sh(repo, 'git add .harness.json && git commit -qm policy && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git checkout -q -b feat/x');
const corpus = new Set(); // every command sent through bash(), reused by the regression check
const bash = (command, cwd = repo) => (corpus.add(command), { tool_name: 'Bash', tool_input: { command }, cwd });

// SID-253: verdicts from a real pre-bash.mjs, in a scratch repo with a local bare origin and no committed policy (the guard is on without one, and the gate, which would run commands, is not).
const here = dirname(fileURLToPath(import.meta.url));
const verdictRepo = makeScratch('harness-verdicts-');
sh(verdictRepo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git branch feat/x');
const BRANCHES = ['feat/x', 'main'], BATCH = 400;
// One batch process at a time; a new one every BATCH commands, since each command's re-import of the entrypoint keeps its module in memory.
const realDenies = (hookFile, commands, branch) => {
  sh(verdictRepo, `git checkout -q ${branch}`);
  const dir = makeScratch('harness-batch-'), inFile = join(dir, 'in.json'), outFile = join(dir, 'out.json'), out = new Map();
  for (let k = 0; k < commands.length; k += BATCH) {
    const part = commands.slice(k, k + BATCH);
    writeFileSync(inFile, JSON.stringify(part));
    const r = spawnSync(process.execPath, [join(here, 'hook-batch.mjs'), hookFile, verdictRepo, inFile, outFile], { encoding: 'utf8', timeout: 300_000 });
    assert.equal(r.status, 0, `hook-batch failed on ${hookFile}: ${r.stderr}`);
    JSON.parse(readFileSync(outFile, 'utf8')).forEach((v, i) => out.set(part[i], v === 1));
  }
  rmSync(dir, { recursive: true, force: true });
  return out;
};
// The same verdict from one real process, the way Claude Code runs the hook: the check that realDenies changes nothing.
const onceDenies = (hookFile, command, branch) => {
  sh(verdictRepo, `git checkout -q ${branch}`);
  const r = spawnSync(process.execPath, [hookFile], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: verdictRepo }), cwd: verdictRepo, encoding: 'utf8', timeout: 120_000 });
  assert.ok(r.status === 0 || r.status === 2, `${hookFile} exited ${r.status} on ${command}: ${r.stderr}`);
  return r.status === 2 || JSON.parse(r.stdout.trim() || '{}').hookSpecificOutput?.permissionDecision === 'deny';
};

// ===== SID-247: the approved loosening of the hook-skip rule (Siddhant via the CTO, Nov 1 2026, 6:10 PM IST) =====
// SFLOW_SID247_ONLY=1 stops after this block (the fast loop in scripts/mutate-merge-n.mjs; npm run check never sets it).
const sid247Rules = newRules, sid247Cfg = { protectedBranches: ['main', 'master'], allowMerge: false };
// CTO review 5730668319: a word in git's global-option position that is quoted, escaped or an expansion and resolves to a dash-word. Git may read the next word as its value, so `merge` can hide a real `git commit -n`.
const SID247_QUOTED_ATTACKS = [
  'git --namespace"" merge commit -n -m x', 'git --namespace"" merge commit -m x -n', 'git -"-namespace" merge commit -n -m x', 'git --namespac\\e merge commit -n -m x', 'git -"C" merge commit -n -m x', 'git -\\C merge commit -n -m x', 'git --namespace"" rebase commit -n -m x', `bash -c 'git --namespace"" merge commit -n -m x'`, 'env git --namespace"" merge commit -n -m x',
  // allowed on e7d30ea, closed here as a tightening (CTO review 5730668319): the old rule never read this line, since it normalizes to `git x commit -n -m x`
  'git --namespace"" x commit -n -m x',
  'git "-C" merge commit -n -m x', "git '--namespace' merge commit -n -m x", 'git \\-C merge commit -n -m x', 'git --git-dir"" merge commit -n -m x', 'git --work-tree"" merge commit -n -m x', 'git merge -n main && git --namespace"" merge commit -n -m x',
  // the same words, as other spellings and behind other forms the guard reads
  'git -"C" . merge -n main', "git $'-C' . merge -n main", "git $'\\x2dC' . merge -n main", 'git -C . --namespace"" merge commit -n -m x', 'git -c a=b -"C" . merge -n main', 'git --namespace`true` merge commit -n -m x', 'git --namespace$(true) merge commit -n -m x', 'git --namespace$X merge commit -n -m x', 'git -$X . merge -n main', 'git "--namespace$(true)" merge commit -n -m x',
  'git >f --namespace"" merge commit -n -m x', 'git 2>&1 -"C" . merge -n main', '"env" git -"C" . merge -n main', 'g"i"t -"C" . merge -n main', '\\git --namespace"" x commit -n -m x', 'timeout 5 git --namespace"" x commit -n -m x', 'sudo -u x git --namespace"" x commit -n -m x', 'xargs git --namespace"" x commit -n -m x', 'chrt -f 5 git -"C" . merge -n main',
  `b"ash" -c 'git -"C" . merge -n main'`, `eval 'git -"C" . merge -n main'`, `echo 'git -"C" . merge -n main' | sh`, 'bash <<E\ngit -"C" . merge -n main\nE', 'echo $(git -"C" . merge -n main)', `bash -c "bash -c 'git -\\"C\\" . merge -n main'"`, 'true && { git -"C" . merge -n main; }',
];
// Found with real git 2.47.3 while fixing that review: plain --shallow-file takes a value too, and gitSub's list doesn't have it, so the same line hides a real hook skip with no quote at all. The merge and rebase lines were denied on e7d30ea and allowed on 704e88f; the x line was already allowed on e7d30ea. Closed as a tightening.
SID247_QUOTED_ATTACKS.push('git --shallow-file merge commit -n -m x', 'git --shallow-file merge commit -m x -n', 'git --shallow-file rebase commit -n -m x', 'git --shallow-file x commit -n -m x', 'env git --shallow-file merge commit -n -m x', `bash -c 'git --shallow-file merge commit -n -m x'`, '/usr/bin/git --shallow-file merge commit -nm x', 'git merge -n main && git --shallow-file merge commit -n -m x', 'git -C . --shallow-file merge commit -n -m x', 'git --shallow-file f merge -n main');
// Newly denied by the same rule, with no merge or commit to hide: pinned collateral. Each could be written plainly, and the deny says how.
const SID247_QUOTED_COLLATERAL = ['git --git-dir="my dir" status', 'git --namespace="x" status', 'git --git-dir=$D status', 'git -"C" . status', 'git "--no-pager" status', 'echo git "-C"'];
const SID247_MUST_ALLOW = [
  'git merge -n main', 'git rebase -n main', 'git merge -n', 'git rebase -n', 'git merge -n -m msg feat', 'git merge -m msg -n feat', 'git rebase -n --onto main feat', 'git merge --no-ff -n feat', 'git merge -n --no-ff feat', 'git merge -n -n feat',
  'git merge -Xignore-space-change main', 'git rebase -Xignore-space-at-eol main', 'git merge -Xpatience main', 'git merge -Xrenormalize main', 'git merge -Xno-renames main', 'git merge -Xfind-renames=50 main', 'git rebase -Xno-renames main',
  'git merge -Xours main', 'git merge -Xtheirs main', 'git rebase -Xours main', 'git rebase -Xtheirs main',
  'git merge -n -Xignore-space-change main', 'git rebase -Xno-renames -n main', 'git rebase -n --empty=keep main',
  'git merge -n main && git status', 'git status; git rebase -n main',
  // a bare -n in option position after an option that takes a value, a positional, or before a --
  'git merge -X ours -n main', 'git merge -m "a b" -n feat', 'git merge -s ort -n main', 'git merge --strategy ort -n main', 'git merge -F msg.txt -n feat', 'git merge --cleanup strip -n feat', 'git rebase --onto main -n feat', 'git rebase -s ort -n main', 'git merge main -n', 'git merge -n -- main', 'git rebase -n -- main', 'git merge -n -q main', 'git rebase -n -i main', 'git rebase -n --rebase-merges main', 'git merge -n --log=5 feat', 'git merge -n -Sabc feat', 'git merge -mfoo -n feat', "git merge -m 'x -vn y' -n feat",
];
const SID247_MUST_DENY = [
  // git commit -n in every form
  'git commit -n', 'git commit -n -m x', 'git commit -nm x', 'git commit -am x -n', 'git commit -nXfoo', 'git commit -vn', 'git commit -m x -n',
  // every whole --no-verify form, alone and beside the allowed forms
  'git commit --no-verify -m x', 'git merge --no-verify main', 'git rebase --no-verify main', 'git merge -n --no-verify main', 'git merge --no-verify -n main', 'git rebase -n --no-verify main', 'git rebase --no-verify -n main', 'git merge -Xours --no-verify main', 'git merge -Xignore-space-change --no-verify main', 'git rebase -Xno-renames --no-verify main', 'git merge -n --no-verify-signatures main',
  // clusters
  'git merge -nv', 'git merge -nv main', 'git merge -vn', 'git merge -vn main', 'git rebase -in', 'git rebase -in main', 'git rebase -ni', 'git rebase -ni main', 'git merge -ns', 'git merge -ns ort main', 'git merge -iXn main', 'git merge -X -nv main', 'git merge -X ours -nv main', 'git merge -n -vn main', 'git rebase -Xours -in main',
  // any --no-verify prefix on the line keeps today's deny (a bare prefix with nothing else stays allowed, pinned below: SID-259)
  'git merge -n --no-verif main', 'git rebase -n --no-veri main', 'git merge -n --no-ver main', 'git merge -n --no-ve main', 'git merge -n --no-v main', 'git merge -n --no- main', 'git merge -n --no main', 'git merge -n --n main', 'git merge -n --no-verif=x main', 'git merge --no-verif -n main', 'git merge -Xno-renames --no-verif main', 'git rebase -Xno-renames --no-veri main', 'git commit -n --no-verif -m x',
  'git merge -n main; git merge --no-verif feat', 'git merge -n main && git commit --no-verif -m x', 'git merge -Xn main; git rebase --no-veri main',
  // rebase --exec, its abbreviations, -x and clusters holding x keep today's deny on a line this rule hits (the bare forms stay allowed, pinned below: SID-260)
  "git rebase -n --exec 'git commit -n' main", "git rebase -n --exec 'make test' main", "git rebase -x 'git commit -n' -n main", "git rebase -n -x 'git commit -n' main", "git rebase -n --exec='git commit -n' main", 'git rebase -n --exec=make main', 'git rebase -n --exe make main', 'git rebase -n --ex make main', 'git rebase -n --e make main', 'git rebase -n --ex=make main', 'git rebase -n -x make main', 'git rebase -n -xmake main', 'git rebase -n -ix make main', 'git rebase -n -xi main', 'git rebase -n -kx make main', 'git rebase -Xno-renames -x make main', 'git rebase -Xn --exec make main', 'git rebase -Xn -ix make main',
  'git merge -n main && git rebase -x make main', 'git rebase -n main; git rebase --exec=make main', "git merge -Xn main && git rebase --exec 'make' main",
  // chained segments: the other segment decides
  'git merge -n main && git commit -n -m x', 'git rebase -n main; git commit -nm x', 'git merge -Xn main || git commit -vn', 'git merge -n main | git commit -n',
  // only exact merge and rebase
  'git merge-file -n a b c', 'git merge-base -n 1 a b', 'git merge-tree -n a b', 'git merge-file -Xn a b c', 'git merge-base --no-verify a b', 'git rebase-x -n',
  // expansions keep the old rule
  'git merge "-${X}n" main', 'git merge -n "$B"', 'git merge "$B"', 'git merge -X$Y main', 'X=-n; git merge $X main', 'git rebase -n "$B"', 'git merge -n $(git rev-parse HEAD)', 'git merge -n `git rev-parse HEAD`', 'Y=-nv; git merge $Y main', "export X=-n; git rebase $X main", '$G -C . merge -n main', '$G --no-pager rebase -n main', 'C="git merge -n main"; $C', 'C="git merge -Xn main"; $C', 'export C="git rebase -n main"; $C', 'A="merge -n"; git $A main', 'A="-n main"; git merge $A', 'G=git; $G -C . merge -n main', 'X=-n; git merge -m $X main', 'X=-n; git merge -m "$X" main', 'X=-Xn; git rebase --onto $X main',
  // -c and env tricks
  'git -c core.hooksPath=/dev/null merge -n main', 'git -c core.hooksPath=/dev/null rebase -n main', 'git -c core.hookspath=x merge -Xours main', 'git --config-env=core.hooksPath=V merge -n main', 'GIT_CONFIG_KEY_0=core.hooksPath git merge -n main', 'HUSKY=0 git merge -n main', 'HUSKY=0 git rebase -Xours main', 'LEFTHOOK=0 git merge -n main', 'SKIP_HOOKS=1 git merge -n main', 'env HUSKY=0 git merge -n main', "bash -c 'HUSKY=0 git merge -n main'", 'git -c include.path=x merge -n main',
  // run 4, the CTO's four shapes: a word after -- is not an option
  'git merge -- -n', 'git merge -- "-n"', "git merge -- '-n'", 'git rebase -- -n', 'git merge main -- -n', 'git merge -n -- -n', 'git merge -- -Xn', 'git merge -- -Xno-renames', 'git merge "--" -n', "bash -c 'git merge -- -n'", 'env git merge -- -n', '/usr/bin/git merge -- -n', 'git status; git merge -- "-n"', 'git merge \\\n -- -n',
  // run 4: the value of an option that takes a separate one is not an option
  'git merge -m "-n" feat', "git merge -m '-n' feat", 'git merge -m -n feat', 'git merge "-m" -n feat', 'git merge -m -n -n feat', 'git merge -n -m -n feat', 'git merge -qm -n feat', 'git merge -m -Xn feat', 'git merge --message -n feat', 'git merge -F -n', 'git merge --file -n', 'git merge -s -n', 'git merge --strategy -n main', 'git merge --strategy-option -n main', 'git merge --into-name -n feat', 'git merge --cleanup -n feat', 'git rebase --onto -n feat', 'git rebase -s -n main', 'git rebase --strategy -n main', 'git rebase -C -n main', 'git rebase --whitespace -n main', 'git rebase --empty -n main', 'bash -c "git merge -m \\"-n\\" feat"', 'command git merge -m -n feat',
  'git merge -X -n main', 'git merge -X "-n" main', "git merge -X '-n' main", 'git rebase -X -n main', 'git rebase --strategy-option -n main', 'git merge -vX -n main', 'git merge -X -Xn main', "sh -c 'git merge -X -n main'", 'env FOO=1 git merge -X -n main', 'git merge -X \\\n -n main', 'git merge -X -n main && git status',
  // run 4: an option git does not list for the command keeps today's verdict, for the whole line
  'git merge -n -x main', 'git merge "-n" -x main', "git merge -n '-x' main", 'git merge -x -n main', 'git merge -n -ax main', 'git merge -n -xa main', 'git merge -n -y main', 'git merge -Xn -x main', 'git merge -n main; git merge -x feat', 'git merge -x feat && git merge -n main', "bash -c 'git merge \"-n\" -x main'", 'sh -c "git merge -n -x main"', '/usr/bin/git merge -n -x main', 'command git merge -n -x main', 'git merge -n \\\n -x main', 'git rebase -n -y main', 'git merge -n --unknown main', 'git merge -n --unknown=1 main', 'git rebase -n --unknown main',
  // run 4: an abbreviated value option can't be told from an abbreviated flag, and a merge option is not a rebase option or the reverse
  'git merge --strat -n main', 'git merge --mess -n feat', 'git merge -n --mess x feat', 'git rebase --ont -n main', 'git merge -n --onto x feat', 'git merge -n --root feat', 'git rebase -n --into-name x main',
  // run 4: a quoted value glued to an option it can't name; the option word is read up to the quote
  "git rebase -n -x'git commit -n' main", 'git rebase -n -x"make test" main', "git merge -n -x'a b' main", "git rebase -n -ix'make test' main", "git rebase -n --exec='make test' main", 'git rebase -n --"exec"=make main', 'git merge -n --"unknown" main',
  ...SID247_QUOTED_ATTACKS, ...SID247_QUOTED_COLLATERAL,
];
// [command, 'deny' | 'allow', why]
const SID247_NEAR = [
  ['git merge -nv', 'deny', 'cluster'], ['git merge -vn', 'deny', 'cluster'], ['git rebase -in', 'deny', 'cluster'], ['git merge -n --no-verify', 'deny', 'whole flag'], ['git commit -nXfoo', 'deny', 'commit cluster'],
  ['git merge -n"v" main', 'deny', 'quotes join into a cluster'], ['git merge "-n"v main', 'deny', 'quotes join into a cluster'], ['git merge -"nv" main', 'deny', 'quotes join into a cluster'], ['git merge -n"" main', 'deny', 'today: the raw text still reads as -n and a quote, not a bare -n'],
  ['git commit -m "-n"', 'deny', "today's verdict: canon reads the word"], ['git merge -Xn"v" -nv main', 'deny', 'the glued -X is skipped, the cluster is not'],
  ['git merge -X ours', 'allow', 'separate -X arg, allowed today'], ['git merge -X ours main', 'allow', 'separate -X arg, allowed today'], ['git merge -X ignore-space-change main', 'allow', 'separate -X arg, allowed today'], ['git rebase -X ignore-space-at-eol main', 'allow', 'separate -X arg, allowed today'],
  ['git merge -X -n main', 'deny', 'run 4: -n is the value of a separate -X, not an option; not in the approved shape'],
  ['git merge -- -n', 'deny', 'run 4: -n after -- is a branch word, not an option; not in the approved shape'], ['git merge -- main', 'allow', 'unchanged'],
  ['git merge -m "-n" feat', 'deny', 'run 4: -n is the value of -m, not an option; not in the approved shape'], ["git merge -m 'a -n b' feat", 'allow', 'one quoted word, allowed today'], ["git commit -m 'a -n b'", 'allow', 'one quoted word, allowed today'],
  ['git merge "-n --no-verify" main', 'allow', "one quoted word, allowed today; git refuses it as an unknown option"], ['git merge -n "--no-verify x" main', 'allow', 'one quoted word that is not the flag; git refuses it'], ["git merge -X'a b' main", 'allow', 'allowed today'], ["git merge -X'a -nv b' main", 'allow', 'one quoted -X value, allowed today'],
  ['git merge -Xn main', 'allow', 'an -X value is not flags'], ['git rebase -Xn main', 'allow', 'an -X value is not flags'], ['git rebase -n -Xsubtree=box main', 'allow', 'the x is in an -X value, not -x'], ['git rebase -iXax main', 'allow', 'allowed today: -i, then -X with value ax'], ['git rebase -n -iXax main', 'allow', 'a bare -n beside -iX with a value that holds x, not -x'], ['git merge -n -x main', 'deny', 'run 4: merge has no -x; an unknown short option keeps today\'s verdict'], ['git merge -x main', 'allow', 'allowed today, no n for the rule to read; git refuses it'], ['git constructor -n', 'allow', 'allowed today: not a command the rule reads, and not a key of the option table'], ['git constructor -x', 'allow', 'allowed today: an inherited key of the option table must not reach the walker'], ['git merge -n main 2>&1', 'allow', 'a redirection is not an option word'], ['git merge -m"a b" -n feat', 'allow', 'a glued quoted value takes no next word'],
  ['git rebase -n --empty=keep --edit-todo', 'allow', '--e prefixes that are not --exec'], ['git merge -n --no-ff --no-edit feat', 'allow', '--no- options that are not a prefix of the flag'],
  // CTO review 5730668319: the quoted-option rule reads global options only. The first three are the approved allowance, denied on e7d30ea and allowed since 704e88f.
  ['git --namespace merge commit -n -m x', 'deny', 'the unquoted control: git runs commit -n, and gitSub reads the same'],
  ['git -C . merge -n main', 'allow', 'a plain global option in front of the approved shape'], ['git --no-pager rebase -n main', 'allow', 'a plain global option in front of the approved shape'], ['git -c "core.pager=less -R" merge -n main', 'allow', 'a quoted value of a plain -c is not an option'],
  ['git -C "some dir" status', 'allow', 'a quoted value of a plain -C is not an option'], ['git -C "-odd dir" status', 'allow', 'the value of a plain -C is not an option, whatever it starts with'], ['git -C "-odd dir" merge -n main', 'allow', 'the value of a plain -C is not an option, whatever it starts with'], ['git log "-1"', 'allow', 'past the subcommand: not a global option'], ['git -c "core.pager=less -R" log "-1"', 'allow', 'past the subcommand: not a global option'], ['git status "-s"', 'allow', 'past the subcommand: not a global option'], ['git "" status', 'allow', 'an empty word does not start with a dash; git refuses it'],
];
// Today's verdict, allowed on e7d30ea and unchanged here: known gaps with their own issues. Do not read these as approved; they are pinned so a fix there is a visible test change.
const SID247_PINS = [
  // SID-260: rebase --exec text is not read (PR C)
  "git rebase -x 'git commit -n -m x' main", "git rebase --exec 'git commit -n -m x' main", "git rebase --exec='git commit -n -m x' main", 'git rebase -x "git commit -nm x" main', "git rebase -i -x 'git commit -n' main", "git rebase --exec 'make -n test' main", "git rebase --exec 'make test' main",
  // SID-259: an abbreviated --no-verify alone (SID-196 item 3)
  'git merge --no-verif main', 'git merge --no-veri main', 'git commit --no-verif -m x', 'git commit --no-veri -m x', 'git rebase --no-verif main', 'git rebase --no-veri main',
  // SID-238: git am is not in this rule
  'git am -n x.patch', 'git am --no-verify x.patch', 'git am --no-verify',
];
const sid247Quotes = (f) => [f, `"${f}"`, `'${f}'`, `-"${f.slice(1)}"`, `-'${f.slice(1)}'`, `\\${f}`, `-\\${f.slice(1)}`, `""${f}`];
const sid247Nest = (x) => (x.includes("'") ? `"${x.replace(/(["\\$`])/g, '\\$1')}"` : `'${x}'`);
const SID247_WRAPS = [(x) => x, (x) => `env ${x}`, (x) => `env FOO=1 ${x}`, (x) => `command ${x}`, (x) => x.replace(/^git /, '/usr/bin/git '), (x) => x.replace(/^git /, 'git -C . '), (x) => x.replace(/^git /, 'git --no-pager '), (x) => x.replace(/ (\S+)$/, ' \\\n $1'), (x) => `bash -c ${sid247Nest(x)}`, (x) => `sh -c ${sid247Nest(x)}`, (x) => `true; ${x}`, (x) => `${x} && git status`];
const sid247Gen = (bases) => [...new Set(bases.flatMap(([t, flags]) => flags.flatMap((f) => sid247Quotes(f).flatMap((q) => SID247_WRAPS.map((w) => w(t(q)))))))];
const SID247_ALLOW_BASES = [
  [(f) => `merge ${f} main`, ['-n', '-Xignore-space-change', '-Xno-renames']],
  [(f) => `rebase ${f} main`, ['-n', '-Xignore-space-at-eol', '-Xno-renames']],
  [(f) => `merge -n ${f} main`, ['-Xpatience']],
];
const SID247_GEN_ALLOW = sid247Gen(SID247_ALLOW_BASES.map(([t, flags]) => [(f) => `git ${t(f)}`, flags]));
const SID247_GEN_DENY = sid247Gen([
  [(f) => `git commit ${f} -m x`, ['-n', '-nq', '-vn']],
  [(f) => `git merge ${f} main`, ['-nv', '-vn', '-ns', '--no-verify']],
  [(f) => `git rebase ${f} main`, ['-in', '-ni', '--no-verify']],
  [(f) => `git merge -n ${f} main`, ['--no-verify', '--no-verif', '-vn']],
  [(f) => `git rebase -n ${f} main`, ['--no-verify', '--no-veri', '-xmake', '-ixmake', '--exec=make', '--ex=make']],
  [(f) => `git merge -n main && git commit ${f} -m x`, ['-n', '-vn']],
  // run 4, the CTO's four shapes
  [(f) => `git merge -- ${f}`, ['-n']],
  [(f) => `git merge -m ${f} feat`, ['-n']],
  [(f) => `git merge -X ${f} main`, ['-n']],
  [(f) => `git merge ${f} -x main`, ['-n']],
  [(f) => `git merge -n ${f} main`, ['-x']],
]);
// CTO review 5730668319: each quoted or escaped global option x merge, rebase x a hidden commit x the wrappers, and in front of the generated allow set.
const SID247_QUOTED_OPTS = ['--namespace""', '-"C"', '-\\C', '--git-dir""', '--work-tree""', '-"-namespace"', '--namespac\\e', '--shallow-file'];
const SID247_QUOTED_WRAPS = [(x) => x, (x) => `bash -c ${sid247Nest(x)}`, (x) => `sh -c ${sid247Nest(x)}`, (x) => `env ${x}`, (x) => `command ${x}`, (x) => x.replace(/^git /, '/usr/bin/git '), (x) => x.replace(/ (\S+)$/, ' \\\n $1'), (x) => `git merge -n main && ${x}`];
const SID247_GEN_QUOTED = [
  ...SID247_QUOTED_OPTS.flatMap((o) => ['merge', 'rebase'].flatMap((s) => ['commit -n -m x', 'commit -m x -n', 'commit -nm x'].flatMap((b) => SID247_QUOTED_WRAPS.map((w) => w(`git ${o} ${s} ${b}`))))),
  ...SID247_QUOTED_OPTS.flatMap((o) => sid247Gen(SID247_ALLOW_BASES.map(([t, flags]) => [(f) => `git ${o} . ${t(f)}`, flags]))),
];
SID247_GEN_DENY.push(...SID247_GEN_QUOTED);
const sid247All = [...SID247_MUST_ALLOW, ...SID247_MUST_DENY, ...SID247_NEAR.map(([c]) => c), ...SID247_PINS, ...SID247_GEN_ALLOW, ...SID247_GEN_DENY];
sid247All.forEach((c) => corpus.add(c));
// The ALLOWLIST matcher (the regression check below): written apart from the guard's own code, so it can't drift with it. It matches a line only when the old rule hits it,
// and every segment it hits is exact git merge or rebase, reads literally, and stops being hit once its bare -n and glued -X option words are out. A --no-verify prefix anywhere rejects the line, and so does a merge or rebase word it can't name: rebase --exec and -x, merge -x, an abbreviation.
// Each pattern is one option word: the first takes the next word as its value, the second doesn't. A -n after -- or after a value word stays, so the old rule still hits it.
const SID247_OLD_RULE = /^git\s+(commit|merge|rebase)\b.*(\s--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)/;
const SID247_OPTION_WORDS = {
  merge: [/^(-[evq]*[mXsF]|--(message|file|strategy|strategy-option|into-name|cleanup))$/, /^(-[evq]*([mXsF]\S+|S\S*)?|--(message|file|strategy|strategy-option|into-name|cleanup)=\S*|--(no-)?(stat|summary|log|squash|commit|edit|ff|rerere-autoupdate|progress|allow-unrelated-histories|gpg-sign|autostash|overwrite-ignore|signoff)(=\S*)?|--(ff-only|verify-signatures|verbose|quiet|verify|abort|quit|continue))$/],
  rebase: [/^(-[qvfmi]*[sXC]|--(onto|whitespace|empty|strategy|strategy-option))$/, /^(-[qvfmi]*([sXC]\S+|[Sr]\S*)?|--(onto|whitespace|empty|strategy|strategy-option)=\S*|--(no-)?(keep-base|signoff|rerere-autoupdate|autosquash|update-refs|gpg-sign|autostash|rebase-merges|fork-point|reschedule-failed-exec|reapply-cherry-picks)(=\S*)?|--(verify|quiet|verbose|no-stat|stat|committer-date-is-author-date|reset-author-date|ignore-date|ignore-whitespace|force-rebase|no-ff|ff|continue|skip|abort|quit|edit-todo|show-current-patch|apply|merge|interactive|root))$/],
};
// CTO review 5730668319: the shared normalization hid quoted global options from this matcher, so it reads them off the command as written, with no guard or lib code. A quoted word with spaces is read again as a script.
const SID247_GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--list-cmds']);
const SID247_WORD = String.raw`(?:\$?"(?:\\[\s\S]|[^"\\])*"|\$?'[^']*'|\\[\s\S]|[^\s;&|()<>])+`;
const sid247Bare = (w) => w.replace(/\$?'([^']*)'|\$?"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/g, (_, a, b, e) => a ?? b?.replace(/\\([\s\S])/g, '$1') ?? e);
const sid247PlainGlobals = (c) => {
  const words = (c.replace(/\\\n/g, '').match(new RegExp(String.raw`\d*[<>]+&?\s*${SID247_WORD}|${SID247_WORD}`, 'g')) ?? []).filter((w) => !/^\d*[<>]/.test(w));
  for (let i = 0; i < words.length; i++) {
    const bare = sid247Bare(words[i]);
    if (bare !== words[i] && /\s/.test(bare) && !sid247PlainGlobals(bare)) return false;
    if (bare.split('/').pop() !== 'git') continue;
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j], b = sid247Bare(w);
      if (w.startsWith("$'") || (b.startsWith('-') && (w !== b || /[$`]/.test(w)))) return false;
      if (!b.startsWith('-')) break;
      if (SID247_GIT_VALUED.has(w)) j++;
    }
  }
  return true;
};
const sid247OptionsOut = (s) => {
  const [, sub, ...args] = s.split(/\s+/), [valued, plain] = SID247_OPTION_WORDS[sub], out = [];
  let value = false, literal = false;
  for (const w of args) {
    const isOption = !literal && !value && (w === '-n' || /^-X\S/.test(w));
    if (!isOption) out.push(w);
    if (literal || isOption) continue;
    if (value) { value = false; continue; }
    if (w === '--') literal = true;
    else if (valued.test(w)) value = true;
    else if (w.startsWith('-') && !valued.test(w.split(/["'\\]/)[0]) && !plain.test(w.split(/["'\\]/)[0])) return null;
  }
  return ['git', sub, ...out].join(' ');
};
const sid247Approved = (c) => {
  if (!sid247PlainGlobals(c)) return false;
  const segs =[...sid247Rules.guardSegments(c)], text = (s) => s.replace(/"[^"]*"|'[^']*'/g, '""'), named = /^git\s+(merge|rebase)\s/;
  const prefixOf = (w, flag) => w.length >= 3 && flag.startsWith(w.split('=')[0]);
  if (segs.some((s) => s.split(/\s+/).some((w) => prefixOf(w, '--no-verify')))) return false;
  if (segs.some((s) => named.test(s) && sid247OptionsOut(text(s)) === null)) return false;
  const hits = segs.filter((s) => SID247_OLD_RULE.test(text(s)));
  return hits.length > 0 && hits.every((s) => named.test(s) && !/[$`]/.test(s) && !SID247_OLD_RULE.test(sid247OptionsOut(text(s))));
};
{
  const wrong = [], bad = (what, c, b, how) => wrong.push(`${what} ${how} on ${b}: ${JSON.stringify(c)}`);
  const ruleDenies = (c, b) => Boolean(sid247Rules.lineReason(c) || sid247Rules.segmentReason(c, sid247Cfg, b));
  const real = Object.fromEntries(BRANCHES.map((b) => [b, realDenies(join(hooks, 'pre-bash.mjs'), [...new Set(sid247All)], b)]));
  const expect = (what, list, want) => { let n = 0; for (const c of list) for (const b of BRANCHES) { let miss = false; for (const [how, got] of [['rule', ruleDenies(c, b)], ['hook', real[b].get(c)]]) if (got !== want) { bad(what, c, b, `${how}: ${got ? 'denied' : 'allowed'}`); miss = true; } if (miss) n++; } return n; };
  const reds = {
    'must-allow': [SID247_MUST_ALLOW.length, expect('must-allow', SID247_MUST_ALLOW, false)],
    'must-deny': [SID247_MUST_DENY.length, expect('must-deny', SID247_MUST_DENY, true)],
    'near-miss': [SID247_NEAR.length, expect('near-miss deny', SID247_NEAR.filter(([, s]) => s === 'deny').map(([c]) => c), true) + expect('near-miss allow', SID247_NEAR.filter(([, s]) => s === 'allow').map(([c]) => c), false)],
    pins: [SID247_PINS.length, expect('pin', SID247_PINS, false)],
    'generated allow': [SID247_GEN_ALLOW.length, expect('generated allow', SID247_GEN_ALLOW, false)],
    'generated deny': [SID247_GEN_DENY.length, expect('generated deny', SID247_GEN_DENY, true)],
  };
  // The matcher takes the approved shape and nothing else.
  for (const c of ['git merge -n main', 'git rebase -n main', 'git merge -Xignore-space-change main', 'git rebase -Xignore-space-at-eol main', 'git merge "-n" main', "bash -c 'git rebase -n main'", 'git merge -n main && git status', 'git merge -m msg -n feat', 'git merge -X ours -n main', 'git rebase --onto main -n feat']) if (!sid247Approved(c)) wrong.push(`matcher must accept: ${c}`);
  for (const c of ['git commit -n -m x', 'git commit -nm x', 'git merge -nv main', 'git merge -vn', 'git rebase -in', 'git merge -n --no-verify main', 'git merge -n --no-verif main', 'git rebase -n --no-veri main', 'git am -n x.patch', 'git am --no-verify', 'git merge-file -n a b c', 'git merge-base -n 1 a b', 'git rebase -n -x make main', 'git rebase -n --exec=make main', 'git merge -n main && git commit -n -m x', 'git merge -n "$B"', 'git merge -Xours main', 'git status', 'git merge -- -n', 'git merge -- "-n"', 'git merge -m "-n" feat', "git merge -m '-n' feat", 'git merge -X -n main', 'git merge -X "-n" main', 'git merge -n -x main', 'git merge "-n" -x main', 'git merge -n main; git merge -x feat', 'git merge -n --unknown main', 'git merge --strat -n main', 'git rebase --onto -n feat', 'git merge -s -n', 'git merge -F -n', 'git merge -n -- -n', 'git merge -n main && git commit --no-verif -m x', ...SID247_QUOTED_ATTACKS, ...SID247_GEN_QUOTED]) if (sid247Approved(c)) wrong.push(`matcher must reject: ${c}`);
  for (const c of ['git -C . merge -n main', 'git --no-pager rebase -n main', 'git -c "core.pager=less -R" merge -n main', 'git -C "some dir" merge -n main', 'git -C "-odd dir" merge -n main']) if (!sid247Approved(c)) wrong.push(`matcher must accept: ${c}`);
  // Each layer on its own: a quoted global option keeps the hook-skip rule whole even without the deny, and the deny says how to rewrite. Without a quoted option the rule stays loose.
  for (const c of SID247_QUOTED_ATTACKS) if (sid247Rules.keepsHookRule?.(sid247Rules.guardSegments(c), c) !== true) wrong.push(`a quoted global option must keep the hook-skip rule: ${c}`);
  for (const c of ['git merge -n main', 'git -C . merge -n main', 'git -c "core.pager=less -R" merge -n main']) if (sid247Rules.keepsHookRule?.(sid247Rules.guardSegments(c), c) !== false) wrong.push(`must not keep the hook-skip rule: ${c}`);
  for (const c of ['git -"C" . status', 'git --namespace"" merge commit -n -m x']) if (!/plainly, unquoted and unescaped/.test(sid247Rules.segmentReason(c, sid247Cfg, 'feat/x')?.why ?? '')) wrong.push(`the deny must say how to rewrite: ${c}`);
  console.log(`SID-247: ${Object.entries(reds).map(([k, [n, r]]) => `${k} ${n} (${r} verdicts wrong)`).join(', ')}, x 2 branches through the rule function and the real pre-bash.mjs`);
  if (process.env.SID247_SHOW) for (const w of wrong) console.log(`  ${w.replace(/\n/g, '\\n')}`);
  assert.deepEqual(wrong.slice(0, 40), [], `SID-247: ${wrong.length} wrong verdicts`);
}
if (process.env.SFLOW_SID247_ONLY === '1') process.exit(0);

// ===== SID-191 re-review 5726947374 (b2b5fd7): R32 =====
// SFLOW_R32_ONLY=1 stops after this block (the fast loop used for mutation testing; npm run check never sets it).
const r32Rules = newRules, r32Cfg = { protectedBranches: ['main', 'master'], allowMerge: false };
const r32Denies = (c, b = 'feat/x') => Boolean(r32Rules.lineReason(c) || r32Rules.segmentReason(c, r32Cfg, b));
const r32Why = (c, b = 'feat/x') => r32Rules.lineReason(c) ?? r32Rules.segmentReason(c, r32Cfg, b)?.why;
const r32Counts = { deny: 0, allow: 0, collateral: 0 };
const r32MustDeny = (list, what) => { for (const c of list) for (const b of ['feat/x', 'main']) assert.ok(r32Denies(c, b), `R32 ${what} must deny on ${b}: ${JSON.stringify(c)}`); r32Counts.deny += list.length; };
const r32MustAllow = (list, what) => { for (const c of list) assert.ok(!r32Denies(c), `R32 ${what} must allow: ${JSON.stringify(c)} (${r32Why(c)})`); r32Counts.allow += list.length; };
// B6: the deny must arrive whole or not at all.
{
  const libFile = join(hooks, 'lib.mjs'), lib = await import(pathToFileURL(libFile).href);
  const dir = makeScratch('harness-r32-nb-'), nb = join(dir, 'nb.cjs'), evf = join(dir, 'ev.json');
  writeFileSync(nb, 'process.stdout;\n'); // touching process.stdout makes the stdout pipe O_NONBLOCK, as a parent that set it would
  const bigCmd = `gh pr merge 1 --body "${Array.from({ length: 3000 }, (_, k) => `line ${k} ${'x'.repeat(1400)}`).join('\n')}"`;
  writeFileSync(evf, JSON.stringify({ tool_name: 'Bash', tool_input: { command: bigCmd }, cwd: repo }));
  assert.ok(bigCmd.length > 4_000_000, 'R32-6: the command is about 4 MB');
  const t0 = Date.now();
  const r = spawnSync('sh', ['-c', `(node -r "${nb}" "${join(hooks, 'pre-bash.mjs')}" < "${evf}"; echo "exit=$?" >&2) | (sleep 1.5; cat)`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const code = Number(/exit=(\d+)/.exec(r.stderr)?.[1]);
  if (code === 0) {
    const j = JSON.parse(r.stdout); // never exit 0 with invalid JSON
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny', 'R32-6: a 4 MB command denies');
    assert.ok(r.stdout.length < 16384, `R32-6: the deny is small (${r.stdout.length} bytes), whatever the command size`);
  } else assert.equal([code, r.stdout].join('|'), '2|', 'R32-6: a failed write exits 2 with nothing on stdout');
  assert.ok(Date.now() - t0 < 15000, `R32-6: the test stays fast (${Date.now() - t0} ms)`);
  // total cap, on the reason itself and on the escaped JSON (control characters grow 6x)
  for (const reason of ['y'.repeat(3000), 'gh pr merge 1\n'.repeat(3000), `a\u0001`.repeat(20000), `${'\u0001'.repeat(1000)}\n`.repeat(10), 'é'.repeat(50000), 'x'.repeat(5_000_000)]) {
    let got = ''; lib.deny(reason, 'PreToolUse', (t) => { got += t; });
    assert.ok(got.length <= 3 * lib.DENY_TOTAL_MAX + 1, `R32-6: deny() output is capped (${got.length} bytes for a ${reason.length}-char reason)`);
    assert.equal(JSON.parse(got).hookSpecificOutput.permissionDecision, 'deny');
    if (reason === 'y'.repeat(3000)) assert.ok(got.length < lib.DENY_LINE_MAX + 200, `R32-6: one long line is cut at DENY_LINE_MAX (${got.length})`);
    if (/^gh pr merge/.test(reason)) { const n = JSON.parse(got).hookSpecificOutput.permissionDecisionReason.length; assert.ok(n >= 3000 && n <= lib.DENY_TOTAL_MAX + 40, `R32-6: the reason is cut at about ${lib.DENY_TOTAL_MAX} chars in total, not per line (${n})`); }
  }
  // emit() retries EAGAIN: a writer that throws it a few times still delivers everything, in order, in short writes
  let calls = 0, sink = '';
  const flaky = (fd, buf, off) => { if (calls++ % 4 < 3) throw Object.assign(new Error('full'), { code: 'EAGAIN' }); const n = Math.min(5, buf.length - off); sink += buf.subarray(off, off + n).toString(); return n; };
  lib.emit('hello world, flaky pipe\n', 1, flaky, () => {});
  assert.equal(sink, 'hello world, flaky pipe\n', 'R32-6: emit() retries EAGAIN and finishes the write');
  // ... but gives up (throws) after 10000 in a row, and on any other error
  // the retry budget is per stalled write, not per call: 10005 stalls spread over a long write still finish
  let stall = 0, got2 = 0; lib.emit('x'.repeat(10005), 1, (fd, buf, off) => { if (stall++ % 2 === 0) throw Object.assign(new Error('full'), { code: 'EAGAIN' }); got2++; return 1; }, () => {});
  assert.equal(got2, 10005, 'R32-6: the EAGAIN counter resets after each successful write');
  // bounded so a retry-forever emit() fails here instead of hanging: the loop is synchronous, SIGTERM can't stop it
  let always = 0; assert.throws(() => lib.emit('x', 1, () => { if (++always > 20000) throw Object.assign(new Error('stop'), { code: 'ESTOP' }); throw Object.assign(new Error('full'), { code: 'EAGAIN' }); }, () => {}), { code: 'EAGAIN' });
  assert.equal(always, 10001, 'R32-6: emit() retries a full pipe 10000 times, then throws');
  let epipe = 0; assert.throws(() => lib.emit('x', 1, () => { epipe++; throw Object.assign(new Error('gone'), { code: 'EPIPE' }); }, () => {}), { code: 'EPIPE' });
  assert.equal(epipe, 1, 'R32-6: emit() does not retry other errors');
  // deny() after a partial write: no second deny, exit 2, reason on stderr
  const partial = spawnSync(process.execPath, ['--input-type=module', '-e', `import { deny } from ${JSON.stringify(pathToFileURL(libFile).href)}; import { writeSync } from 'node:fs'; deny('first', 'PreToolUse', (t) => { writeSync(1, t.slice(0, 7)); throw Object.assign(new Error('full'), { code: 'EAGAIN' }); }); process.stdout.write('REACHED-AFTER-DENY');`], { encoding: 'utf8' });
  assert.equal(partial.status, 2, 'R32-6: a failed deny write exits 2');
  assert.equal(partial.stdout, '{"hookS', 'R32-6: nothing but the partial write is on stdout (no second deny, no allow)');
  assert.match(partial.stderr, /blocked/, 'R32-6: the reason is on stderr');
  console.log(`SID-191 R32-6: 4 MB command denied over a nonblocking pipe in ${Date.now() - t0} ms; deny() capped; emit() retry and failure paths tested`);
}
const r32Ours = ['set -o noglob; git status', 'IFS=, git status', `sh -c 'echo "$1"' _ x`]; // R32 cases the corpus sweep below must not count as collateral
// Over-denial 1: harmless `set -o` options. noglob, braceexpand, posix and `set --` change how words are read and stay denied.
r32MustAllow(['set -o pipefail; gh pr view 1 | cat', 'set -o pipefail && git push origin feat/x', 'set -euo pipefail; git status', 'set -o errexit -o nounset; git status', 'set +o noclobber; git status', 'set -o verbose; git log'], 'set -o whitelist');
r32MustDeny(['set -o noglob; git status', 'set -o braceexpand; git status', 'set +o noglob; gh pr view 1', 'set -o posix; git status', 'set -o pipefail -o noglob; git status', 'set -- a b; git status', 'set -o; git status', 'set -o keyword; git status', 'set -o allexport -o noglob; npm test', 'set -o xtrace; npm test', 'set -o errtrace; git status', 'set -o functrace; git status', 'set -o allexport; git status'], 'set -o other options');
// Over-denial 2: IFS is judged on assignment words. A mention in a message or an echo argument is data; a real assignment, or text a shell/redirect could read back, is not.
r32MustAllow(['git commit -m "set IFS=, in parser"', 'echo "set IFS=, here"; git status', "git commit -m 'IFS=, is documented'", 'git tag -m "reset IFS= first" v1', 'git commit -m "fix (parser) IFS=x"', 'git tag -m "IFS=, note" v1', 'git commit -m "IFS=, note" && git status'], 'IFS mention');
r32MustDeny(['IFS=, git status', 'IFS=, ; git status', 'IFS+=x; git status', 'export IFS=,; git status', 'declare -x IFS=, ; git status', 'local IFS=,; git status', 'FOO=1 IFS=, git status', "echo 'a IFS=, b' | sh; git status", 'git commit -m "$(IFS=, ; echo x)"', 'echo "x IFS=, y" > f.sh; git status', 'bash -c "IFS=,; git status"', 'eval "IFS=, git status"', 'echo "x IFS=, y" | tee f.sh; git status'], 'IFS assignment');
// Over-denial 3: `$1` inside the single quotes of a -c payload (an awk program) or escaped is not a positional parameter. Real uses stay denied.
r32MustAllow([`bash -c "awk '{print \\$1}' f; git status"`, `sh -c 'git log --oneline | awk "{print \\$1}"'`, `bash -c "awk '{print \\$1, \\$2}' f | sort; git log"`, `sh -c "cut -d' ' -f1 f | awk '{ s += \\$1 } END { print s }'; git status"`], 'awk $1 in a payload');
r32MustDeny([`sh -c 'echo "$1"' _ x`, `bash -c 'echo $@; git status'`, `bash -c 'shift; git status'`, `bash -c "echo \\$1; git status"`, `bash -c "awk '{print \\$1}' f; echo \\$2; git status"`, `sh -c 'awk "{print $1}"; git status'`, `bash -c 'eval "$1"' _ 'gh pr merge 1'`, `bash -c "eval '\\$1'" _ 'gh pr merge 1'`, `sh -c '"$@"' _ gh pr merge 1`], 'real positional use');
r32MustDeny([String.raw`bash -c "echo \"it's \$1\" 'x'; git status"`], 'apostrophe inside double quotes does not hide $1');
// Through the hook as well (these join the corpus, so the regression check below runs them against every baseline)
for (const c of ['set -o pipefail; gh pr view 1 | cat', 'git commit -m "set IFS=, in parser"', `bash -c "awk '{print \\$1}' f; git status"`]) assert.ok(!denied('pre-bash.mjs', bash(c)), `R32 over-denial fixed, must allow through the hook: ${c}`);
for (const c of ['set -o noglob; git status', 'IFS=, git status', `sh -c 'echo "$1"' _ x`]) assert.ok(denied('pre-bash.mjs', bash(c)), `R32 must still deny through the hook: ${c}`);
// each rule on its own (the line-level layers can hide one of them)
assert.equal(r32Rules.rereadReason('set -o pipefail; git status'), null);
assert.ok(r32Rules.rereadReason('set -o noglob; git status'));
assert.equal(r32Rules.rereadReason('git commit -m "set IFS=, in parser"'), null);
assert.ok(r32Rules.rereadReason('IFS=, git status'));
assert.ok(r32Rules.rereadReason("echo 'a IFS=, b' | sh; git status"));
assert.ok(r32Rules.rereadReason('git commit -m "$(IFS=, ; echo x)"'), 'R32: a $( ) inside double quotes is script, not data');
assert.equal(r32Rules.segmentReason(`bash -c "awk '{print \\$1}' f; git status"`, r32Cfg, 'feat/x'), null);
assert.match(r32Rules.segmentReason(`bash -c 'echo $1'`, r32Cfg, 'feat/x')?.why ?? '', /positional parameters/);
// Message: an unquoted glob or brace in a guarded command is still denied (accepted collateral), and the message now says to quote.
const r32Glob = ['gh api repos/o/r/pulls?state=open', 'gh api repos/o/r/pulls --jq .[]', 'uv add pkg[extra]', 'git add *.mjs'];
r32MustDeny(r32Glob, 'unquoted glob');
r32Counts.collateral += r32Glob.length;
for (const c of r32Glob) { const why = r32Why(c); assert.match(why, /spell the paths or words out/, c); assert.match(why, /quote the argument/, c); assert.match(why, /gh api 'repos\/o\/r\/pulls\?state=open', --jq '\.\[\]', uv add 'pkg\[extra\]'/, c); }
r32MustAllow(["gh api 'repos/o/r/pulls?state=open'", "gh api repos/o/r/pulls --jq '.[]'", "uv add 'pkg[extra]'", "gh api 'repos/o/r/pulls?state=open' --jq '.[].number'"], 'quoted glob');
// Opus final review: single-quoted text that the script reads back as code, and $'..' with an escaped quote, must not hide a positional parameter or an IFS assignment.
// All of these were denied at b2b5fd7 and stay denied.
r32MustDeny([
  String.raw`bash -c ". /dev/stdin <<< '${'$'}{1#}'" _ 'gh pr merge 1'`, String.raw`bash -c "source <(echo '\${1#}')" _ 'gh pr merge 1'`, String.raw`bash -c "echo '\${1#}' | source /dev/stdin" _ 'gh pr merge 1'`,
  String.raw`bash -c "trap '\${1#}' EXIT" _ 'gh pr merge 1'`, String.raw`bash -c "trap '\$1' EXIT" _ 'gh pr merge 1'`, String.raw`bash -c "PROMPT_COMMAND='\${1#}'; trap '' EXIT" _ 'gh pr merge 1'`,
  String.raw`bash -c "x=\$'\\''; \${@}; y=''" _ gh pr merge 1`,
  String.raw`x=$'\'' ; IFS=, ; c=gh,pr,merge,1 ; $c ; y=''`,
  "trap ' IFS=,; c=gh,pr,merge,1; $c' EXIT", "perl -e 'system q{ IFS=,; c=gh,pr,merge,1; $c}'", `python3 -c 'os.system(" IFS=,; c=gh,pr,merge,1; $c")'`, `awk 'BEGIN{system(" IFS=,; c=gh,pr,merge,1; $c")}'`,
  `node -e 'execSync(" IFS=,; c=gh,pr,merge,1; $c")'`, "env -S ' IFS=, c=gh,pr,merge,1 git status'",
], 'opus review: re-read single-quoted text and $\'..\'');
// each guard on its own
assert.ok(r32Rules.rereadReason("trap ' IFS=,; git status' EXIT"), 'R32: trap re-reads quoted text, so an IFS inside it counts');
assert.ok(r32Rules.rereadReason(String.raw`x=$'\'' ; IFS=, ; git status ; y=''`), "R32: $'..' falls back to the raw text");
assert.match(r32Rules.segmentReason(String.raw`bash -c "trap '\${1#}' EXIT" _ x`, r32Cfg, 'feat/x')?.why ?? '', /positional parameters/, 'R32: a payload that can re-read single-quoted text is judged on the raw text');
// the deny keeps the end of a long reason (a gate failure's last lines, the policy note), not only the start
{
  const lib = await import(pathToFileURL(join(hooks, 'lib.mjs')).href);
  let got = ''; lib.deny(`${'first line\n'.repeat(900)}LAST-LINE-ERROR`, 'PreToolUse', (t) => { got += t; });
  const why = JSON.parse(got).hookSpecificOutput.permissionDecisionReason;
  assert.ok(why.startsWith('first line') && why.endsWith('LAST-LINE-ERROR') && why.length <= lib.DENY_TOTAL_MAX + 60, `R32-6: the cut keeps both ends (${why.length})`);
}
// Second opus review (/tmp/r32/opus2-result.md): findings 1-4, each denied at b2b5fd7 and allowed by the first fix. Plain payload text is never blanked unless it is the program of awk/gawk/sed/cut/grep/jq.
const r32Op2 = [
  // 1: a quoted or escaped reader name hides the re-read of single-quoted ${1#}
  String.raw`bash -c "\"trap\" '\${1#}' EXIT" _ 'gh pr merge 1'`, String.raw`bash -c "t''rap '\${1#}' EXIT" _ 'gh pr merge 1'`, String.raw`bash -c "\trap '\${1#}' EXIT" _ 'gh pr merge 1'`,
  String.raw`bash -c "\"trap\" '\$@' EXIT" _ gh pr merge 1`, String.raw`bash -c "\"source\" /dev/stdin <<< '\${1#}'" _ 'gh pr merge 1'`,
  String.raw`bash -c "\"trap\" '\${1#}' EXIT" _ 'git push origin main'`, String.raw`bash -c "\"trap\" '\${1#}' EXIT" _ 'echo x > .harness.json'`,
  // 2: other places bash re-reads single-quoted text
  String.raw`bash -c "PS4='\$(\${1#})'; set -x; :" _ 'gh pr merge 1'`, String.raw`bash -c "PS0='\$(\${1#})'; :" _ 'gh pr merge 1'`, String.raw`bash -c "a='b[\$(\${1#})]'; echo \$((a))" _ 'gh pr merge 1'`,
  String.raw`bash -c "unset 'a[\$(\${1#})]'" _ 'gh pr merge 1'`, String.raw`bash -c "x='\$(\${1#})'; echo \"\${x@P}\"" _ 'gh pr merge 1'`,
  "bash -c \"shopt -s expand_aliases; alias x='\\${1#}'\nx\" _ 'gh pr merge 1'", String.raw`bash -c "mapfile -C '\${1#}' -c1 a <<<x" _ 'gh pr merge 1'`,
  // 3: options that run code (xtrace via PS4, errtrace/functrace via trap, allexport exports the next assignment)
  "PS4='$(gh pr merge 1)'; set -o xtrace; true", "set -o errtrace; trap 'gh pr merge 1' ERR; false", "set -o functrace; trap 'gh pr merge 1' DEBUG; f(){ :; }; f", 'set -o allexport; GIT_SSH_COMMAND=/tmp/evil; git push origin feat/x',
  'set -o allexport; BASH_ENV=/tmp/evil; git status', 'set -o allexport; GIT_EXTERNAL_DIFF=/tmp/evil; git diff', 'set -o allexport; GIT_PAGER=/tmp/evil; git log', 'set -o allexport; GIT_DIR=/tmp/other; git status',
  // 4: an apostrophe in a comment, or nested quotes in "$( )", hid a real IFS assignment
  "# it's\nIFS=,; c=1,--web; gh pr view $c # '", "git status # don't\nIFS=,; c=1,--web; gh pr view $c # '", 'echo "$(echo "a"; IFS=,; c=1,--web; gh pr view $c)"',
];
r32MustDeny(r32Op2, 'opus 2 findings 1-4');
for (const c of r32Op2.filter((_, k) => k % 3 === 0)) assert.ok(denied('pre-bash.mjs', bash(c)), `R32 opus 2 must deny through the hook: ${JSON.stringify(c)}`);
r32Ours.push(...r32Op2);
// Third opus review: an alias that turns a data-program head into eval, IFS assigned in arithmetic inside quotes, and extra set flags/words after a safe `-o NAME`. All denied at b2b5fd7.
const r32Op3 = [
  String.raw`sh -c "alias awk=eval
awk '\${1#}'" _ 'gh pr merge 1'`, String.raw`bash -c "shopt -s expand_aliases
alias awk=eval
awk '\${1#}'" _ 'gh pr merge 1'`, String.raw`sh -c "alias grep=eval
grep 'shift; \$1'" _ x 'gh pr merge 1'`, String.raw`sh -c "alias sed=eval
sed '\${@:2}'" _ x gh pr merge 1`, String.raw`sh -c 'alias jq=eval
jq "\${1#}"' _ 'gh pr merge 1'`, String.raw`sh -c "alias awk=eval; awk '\${1#}'" _ 'gh pr merge 1'`,
  'echo "$[ IFS=44 ]"; gh pr create --title x', 'echo $[ " IFS=7" ]; git status', 'x=a; echo "${x[ IFS=5]}"; git status', "test -v 'a[ IFS=4 ]'; git status",
  'set -o pipefail -f; git status', 'set -o pipefail -k; git status', 'set -o pipefail -f pipefail; git status', 'set -o pipefail main; git push origin $1', 'set -o pipefail - gh pr merge 1; git status', 'set -o pipefail +B; git status', 'set -o errexit -B -o nounset; git status',
  'set -o pipefail -H; git status', 'set -o pipefail -C -u; git status', 'set -o verbose x y; gh pr view "$2"', 'set -o pipefail -k; git push origin feat/x GIT_SSH_COMMAND=/tmp/evil', 'set -o pipefail -o pipefail -f; gh pr view 1',
];
r32MustDeny(r32Op3, 'opus 3');
for (const c of r32Op3.filter((_, k) => k % 4 === 0)) assert.ok(denied('pre-bash.mjs', bash(c)), `R32 opus 3 must deny through the hook: ${JSON.stringify(c)}`);
r32Ours.push(...r32Op3);
// each rule on its own
for (const c of ['set -o pipefail -k; git status', 'set -o pipefail x; git status', 'set -o pipefail - a; git status', 'set -o pipefail -o noglob; git status']) assert.ok(r32Rules.rereadReason(c), `R32 set: every argument must be a safe -o pair: ${c}`);
assert.equal(r32Rules.rereadReason('set -o errexit -o nounset; git status'), null);
assert.match(r32Rules.positionalView(`alias awk=eval; awk '\${1#}'`), /\$\{1/, 'R32: an alias in the payload keeps the raw text');
assert.match(r32Rules.positionalView(`shopt -s expand_aliases; awk '$1'`), /\$1/);
assert.match(r32Rules.positionalView(`npm test; awk '$1'`), /\$1/, 'R32: a payload with a command that is neither a data program nor plain stays raw');
assert.doesNotMatch(r32Rules.positionalView(`git status; awk '$1' f | sort`), /\$1/);
for (const c of ['echo "$[ IFS=44 ]"; git status', 'echo $[ " IFS=7" ]; git status', 'echo "${x[ IFS=5]}"; git status', "test -v 'a[ IFS=4 ]'; git status"]) assert.ok(r32Rules.rereadReason(c), `R32 IFS: arithmetic expansion keeps the raw rule: ${c}`);
// the narrow allows stay, each rule on its own
r32MustAllow([`bash -c "awk '{print \\$1}' f | sort; sed 's/a/\\$1/' f; git status"`, `bash -c "grep -E 'x\\$' f | cut -d' ' -f1; jq '.[]' f"`], 'data-program single quotes');
assert.equal(r32Rules.rereadReason('git status # it\'s'), null);
assert.ok(r32Rules.rereadReason('echo "$(echo "a"; IFS=,; git status)"'), 'R32 opus 2 F4: nested quotes in "$( )" keep the raw rule');
assert.ok(r32Rules.rereadReason("git status # don't\nIFS=,; git status # '"), 'R32 opus 2 F4: an apostrophe in a comment keeps the raw rule');
assert.ok(r32Rules.rereadReason('echo "x IFS=, y" | eval; git status'), 'R32: an unknown or reading command keeps the raw rule');
assert.ok(r32Rules.rereadReason('FOO="a IFS=, x" git status'), 'R32: a quoted assignment value is not on the data list');
assert.ok(r32Rules.rereadReason('echo IFS=, ; git status'), 'R32: an unquoted IFS= argument keeps the raw rule');
assert.ok(r32Rules.rereadReason('git -c core.pager="a IFS=, x" log'), 'R32: git -c is not a message command');
assert.ok(r32Rules.rereadReason('git log --format="a IFS=, x"'), 'R32: a quoted word that is not a message value keeps the raw rule');
assert.equal(r32Rules.rereadReason('gh pr create --title "set IFS=, here" --body "IFS=, too"'), null);
// ifsMentionIsData, one gate at a time (each of these returns the raw rule's answer, which is a deny; the layers above would hide a missing gate)
for (const c of [
  String.raw`x=$'\'' ; IFS=, ; git status ; y='x'`, // litCommands misreads $'\'' as the end of the string
  'echo "x; IFS=, ; git status', // unclosed double quote
  'echo "$(IFS=, ; git status)"', // $( ) inside double quotes
  'echo $(IFS=, ; git status)',
  '"echo" "a IFS=, b"; git status', // a quoted command name is not on the list
  'echo IFS+=x; git status', // += is an assignment too
  'echo IFS=x; git status',
  'gh pr create --label "a IFS=, b"', // a quoted word that is not a title/body
  'git log --grep "a IFS=, b"', // not a message option
  'git -c core.pager="a IFS=, b" log',
  'git commit -m x --exec="a IFS=, b"',
  String.raw`echo $'\'\'' ; IFS=, ; git status ; echo 'x'`, // litCommands ends $'..' at the first quote, so it would read the IFS as quoted
  'echo "`IFS=, ; git status`"', // a backtick in double quotes
  'unknowncmd "a IFS=, b"; git status', 'git status # a IFS=, b', 'git commit -m #x IFS=, y', // a comment keeps the raw rule (b2b5fd7 denied it; allowing it would be a DENY->allow)
  'echo "a IFS=, b" | sh; git status', 'echo "a IFS=, b" > f; git status', 'trap "a IFS=, b" EXIT; git status', 'perl -e "a IFS=, b"; git status',
]) assert.ok(r32Rules.rereadReason(c), `R32 IFS gate must keep the raw rule: ${JSON.stringify(c)}`);
for (const c of ['git commit -m "a IFS=, b"', 'git tag -m "a IFS=, b" v1', 'echo "a IFS=, b"; git status', "printf '%s\\n' 'a IFS=, b'; git status", 'gh pr create --title "a IFS=, b" --body "c IFS=, d"', 'git notes add -m "a IFS=, b"; git status', 'ls "a IFS=, b"; git status'])
  assert.equal(r32Rules.rereadReason(c), null, `R32 IFS mention in plain data stays allowed: ${c}`);
// The IFS reason itself, for heads a later rule also denies (eval, read, ...): only the reason shows that the data gate kept the raw rule for them.
for (const h of ['eval', 'read', 'mapfile', 'alias', 'shopt', 'source', 'sh', 'bash', 'trap', 'xargs', 'tee', 'python3']) assert.match(r32Rules.rereadReason(`${h} "a IFS=, b"; git status`) ?? '', /sets IFS/, `R32 IFS gate: ${h} is not a plain command, so its quoted text keeps the raw IFS rule`);
// positionalView, one construct at a time: a payload is the raw text unless every command is plain and the quoted words belong to an awk/gawk/sed/cut/grep/jq program
const pv = r32Rules.positionalView;
// A command that runs or re-reads text is neither plain nor a data program: as a head its own quoted words stay, and one such command anywhere keeps the raw text of the whole payload.
for (const h of ['sh', 'bash', 'dash', 'zsh', 'eval', 'source', '.', 'trap', 'exec', 'command', 'builtin', 'alias', 'env', 'xargs', 'python3', 'perl', 'node']) {
  assert.match(pv(`${h} '$1'`), /\$1/, `R32 payload view must keep the raw $1 of a ${h} word`);
  assert.match(pv(`${h} x; awk '$1' f`), /\$1/, `R32 payload view: ${h} next to a data program keeps the whole payload raw`);
}
for (const c of [
  `"awk" '{print $1}'`, `awk '{print $1}' a\\ b`, `awk '{print $1}' f > out`, `awk '{print $1}' < f`, `(awk '{print $1}' f)`, `awk '{print $1}' $(echo f)`, `awk "$(x)" '{print $1}'`, 'awk `x` \'{print $1}\'',
  `awk "a\\nb" '{print $1}'`, `echo 'x $1`, 'awk "a\\$1', `awk '{print $1}' f # c`, `awk '{print $1}' {a,b}`, `awk '{print $1}' (f)`, `awk '{print $1}' $'x'`, `echo '$1'`, `trap '$1' EXIT`, `x=1 awk '{print $1}'`, `env awk '{print $1}'`, `xargs awk '{print $1}'`, `echo $1; awk '{print $1}'`, `awk '{print $1}' "$1"`,
]) assert.match(pv(c), /\$[1@]/, `R32 payload view must keep the raw $1: ${JSON.stringify(c)}`);
for (const c of [`awk '{print $1}' f`, `gawk '{print $1, $2}' f | sort`, `sed 's/a/$1/' f`, `cut -d' ' -f1 f | awk '{ s += $1 } END { print s }'`, `grep -E 'x$' f`, `jq '.[$1]' f`, `git log --oneline | awk "{print \\$1}"`])
  assert.doesNotMatch(pv(c), /\$[1@]/, `R32 payload view drops a data program's $1: ${c}`);
// R32-END (cases of the other items are added above this line)
if (process.env.SFLOW_R32_ONLY === '1') { console.log(`R32 only: ${JSON.stringify(r32Counts)}`); process.exit(0); }

// SID-213: the push secret scan fails closed, reads every commit in the pushed range, and can't be blinded by repo config.
// The cases collect their failures so one run names every broken behaviour.
{
  const realGit = sh(repo, 'command -v git'), head = (d) => sh(d, 'git rev-parse HEAD');
  const NET = /committed text looks like a secret \(AWS key\)/, HISTORY = /a commit in the pushed range adds text that looks like a secret \(AWS key\)/, CLOSED = /could not read the diff for the secret scan \(failing closed\)/;
  const scanRepo = (policy = { gate: ['test -f a'] }) => {
    const d = makeScratch('harness-scan-');
    sh(d, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init');
    writeFileSync(join(d, '.harness.json'), JSON.stringify(policy));
    sh(d, 'git add .harness.json && git commit -qm policy && git clone -q --bare . "$(pwd).origin.git" && git remote add origin "$(pwd).origin.git" && git fetch -q origin && git checkout -q -b feat/x');
    return d;
  };
  const addToken = (d, file = 's.txt') => sh(d, `echo "k=${TOKEN}" > ${file} && git add ${file} && git commit -qm add-${file}`);
  const addRemove = (d) => { addToken(d); sh(d, 'git rm -q s.txt && git commit -qm remove-s'); };
  const clean = (d, file = 'c') => sh(d, `echo ${file} > ${file} && git add ${file} && git commit -qm ${file}`);
  const gitDirOf = (d) => sh(d, 'git rev-parse --absolute-git-dir');
  const gateRuns = (d, sha) => { const f = join(gitDirOf(d), 'harness', 'runs.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'gate' && r.head === sha.slice(0, 12)) : []; };
  const push = (d, env = {}) => {
    const out = execFileSync('node', [join(hooks, 'pre-bash.mjs')], { cwd: d, env: { ...process.env, ...env }, timeout: 120_000, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin feat/x' }, cwd: d }) }).toString().trim();
    const sha = head(d);
    return { why: reasonOf(out ? JSON.parse(out) : null), recorded: existsSync(join(gitDirOf(d), GATE_RECORD_DIR, sha)), runs: gateRuns(d, sha) };
  };
  const refused = (r, why, result) => {
    assert.match(r.why, why);
    assert.ok(!r.recorded, 'no gate record');
    assert.ok(r.runs.some((x) => x.result === result), `runs.jsonl has result ${result}: ${JSON.stringify(r.runs)}`);
    assert.ok(!r.runs.some((x) => x.result === 'pass'), 'runs.jsonl has no pass for this head');
  };
  const passed = (r) => { assert.equal(r.why, ''); assert.ok(r.recorded, 'gate record written'); };
  const shim = (sub) => {
    const dir = makeScratch('harness-shim-');
    writeFileSync(join(dir, 'git'), `#!/bin/sh\nskip=\nfor a in "$@"; do\n  if [ -n "$skip" ]; then skip=; continue; fi\n  case "$a" in -c|-C) skip=1; continue;; -*) continue;; esac\n  if [ "$a" = "${sub}" ]; then echo "fatal: shim refused ${sub}" >&2; exit 128; fi\n  break\ndone\nexec "${realGit}" "$@"\n`);
    chmodSync(join(dir, 'git'), 0o755);
    return { PATH: `${dir}:${process.env.PATH}` };
  };
  const blinders = {
    'color.ui=always': (d) => sh(d, 'git config color.ui always'),
    'color.diff=always': (d) => sh(d, 'git config color.diff always'),
    'diff.external': (d) => { const x = join(gitDirOf(d), 'silent-diff'); writeFileSync(x, '#!/bin/sh\nexit 0\n'); chmodSync(x, 0o755); sh(d, `git config diff.external "${x}"`); },
    'textconv': (d) => { const x = join(gitDirOf(d), 'silent-conv'); writeFileSync(x, '#!/bin/sh\necho clean\n'); chmodSync(x, 0o755); writeFileSync(join(d, '.gitattributes'), '*.txt diff=hide\n'); sh(d, `git config diff.hide.textconv "${x}" && git add .gitattributes && git commit -qm attrs`); },
    'core.bigFileThreshold=10': (d) => sh(d, 'git config core.bigFileThreshold 10'),
    'core.attributesFile * -diff': (d) => { const x = join(gitDirOf(d), 'attrs'); writeFileSync(x, '* -diff\n'); sh(d, `git config core.attributesFile "${x}"`); },
    'core.attributesFile diff=bin with diff.bin.binary': (d) => { const x = join(gitDirOf(d), 'attrs'); writeFileSync(x, '* diff=bin\n'); sh(d, `git config core.attributesFile "${x}" && git config diff.bin.binary true`); },
    'committed .gitattributes -diff': (d) => { writeFileSync(join(d, '.gitattributes'), '*.txt -diff\n'); sh(d, 'git add .gitattributes && git commit -qm attrs'); },
    'committed .gitattributes binary': (d) => { writeFileSync(join(d, '.gitattributes'), '*.txt binary\n'); sh(d, 'git add .gitattributes && git commit -qm attrs'); },
    '.git/info/attributes -diff': (d) => writeFileSync(join(gitDirOf(d), 'info', 'attributes'), '* -diff\n'),
  };
  const nulToken = `printf 'k=${TOKEN}\\000\\n'`;
  const bigBinary = (d) => writeFileSync(join(d, 'big.bin'), Buffer.alloc(1 << 20, 'ab\0\n'));
  const logWithoutGraftOverride = (d, range) => sh(d, `env -u GIT_GRAFT_FILE git log -p --cc --root --full-history --format=%H ${range}`);
  const oldRecord = (d) => { const dir = join(gitDirOf(d), 'harness-gate'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, head(d)), 'x\n'); }; // 0.5.0's folder: a head recorded there passed the weaker scan
  const stopReason = (d) => run('stop.mjs', { cwd: d })?.reason ?? '';
  const side = (d, name) => sh(d, `git checkout -q -b ${name} && echo ${name} > ${name} && git add ${name} && git commit -qm ${name} && git checkout -q feat/x`);
  const dropLast = (d, file) => sh(d, `sed -i '$d' ${file} && git add ${file} && git commit -qm remove-last-line`);
  const evilMerge = (d, write = `echo "k=${TOKEN}"`) => { side(d, 'o1'); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 && ${write} > merged.txt && git add merged.txt && git commit -qm evil`); assert.equal(sh(d, 'git rev-list --parents -n1 HEAD').split(' ').length, 3, 'a merge commit'); sh(d, 'git rm -q merged.txt && git commit -qm remove'); };
  const lateNulToken = `{ for i in $(seq 120); do echo ${'p'.repeat(80)}; done; printf 'x\\000k=${TOKEN}\\n'; }`;
  const changedAgainstAllParents = (d, ref, name) => sh(d, `git diff-tree -c --name-only -z --no-commit-id ${ref}`).split('\0').includes(name);
  const octopus = (d, n, content) => {
    const parent = head(d), tree = sh(d, 'git rev-parse HEAD^{tree}');
    const parents = sh(d, `for i in $(seq ${n}); do git commit-tree ${tree} -p ${parent} -m p$i; done`).split('\n');
    const merged = content ? sh(d, `blob=$(printf '%s\\n' '${content}' | git hash-object -w --stdin) && git update-index --add --cacheinfo 100644,$blob,merged.txt && git write-tree && git reset -q`) : tree;
    sh(d, `git reset -q --hard $(git commit-tree ${merged} ${parents.map((p) => `-p ${p}`).join(' ')} -m octopus)`);
    assert.equal(sh(d, 'git rev-list --parents -n1 HEAD').split(' ').length, n + 1, `${n} parents`);
  };
  const refusedWide = (d, n = 64) => { const r = push(d); refused(r, new RegExp(`a merge in the pushed range has ${n} parents`), 'error'); assert.match(r.why, /failing closed/); assert.match(r.why, /split/i); };
  const b64 = (text) => Buffer.from(text).toString('base64');
  const script = (d, name, body) => { const x = join(gitDirOf(d), name); writeFileSync(x, `#!/bin/sh\n${body}\n`); chmodSync(x, 0o755); return x; };
  const textconvFile = (d, driver = 'base64 -d') => { writeFileSync(join(d, '.gitattributes'), '*.b64 diff=z\n'); writeFileSync(join(d, 'k.b64'), `${b64(`k=${TOKEN}\n`)}\n`); sh(d, `git config diff.z.textconv '${driver}' && git add .gitattributes k.b64 && git commit -qm encoded`); };
  // Git trusts a graph file's parent column: only `git commit-graph verify` reads the checksum.
  const poisonGraph = (d, parents, generations = {}) => {
    sh(d, 'git -c commitGraph.generationVersion=1 commit-graph write --reachable --no-progress');
    const f = join(gitDirOf(d), 'objects', 'info', 'commit-graph'), b = readFileSync(f);
    const chunk = (id) => { for (let i = 8; ; i += 12) if (b.toString('latin1', i, i + 4) === id) return Number(b.readBigUInt64BE(i + 4)); };
    const oids = chunk('OIDL'), count = b.readUInt32BE(chunk('OIDF') + 255 * 4);
    const pos = (sha) => { for (let i = 0; i < count; i++) if (b.toString('hex', oids + 20 * i, oids + 20 * i + 20) === sha) return i; throw new Error(`${sha} not in the graph`); };
    const row = (sha) => chunk('CDAT') + 36 * pos(sha);
    for (const [commit, parent] of parents) b.writeUInt32BE(pos(parent), row(commit) + 20);
    for (const [sha, gen] of Object.entries(generations)) b.writeUInt32BE(gen << 2, row(sha) + 28);
    rmSync(f, { force: true }); writeFileSync(f, b);
  };
  const fakeGpg = (d) => {
    const marker = join(gitDirOf(d), 'gpg-ran');
    return { marker, program: script(d, 'fake-gpg', `case "$*" in *--verify*) : > "${marker}";; esac\ncase "$*" in *-bsau*) echo '[GNUPG:] SIG_CREATED ' >&2; printf -- '-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n';; esac\nexit 0`) };
  };
  const diffOffTxt = (d) => { writeFileSync(join(d, '.gitattributes'), '*.txt -diff\n'); sh(d, 'git add .gitattributes && git commit -qm attrs'); };

  const cases = {
    'a failing git diff denies, records error, no pass, no gate record': () => { const d = scanRepo(); clean(d); const r = push(d, shim('diff')); refused(r, CLOSED, 'error'); assert.match(r.why, /fatal: shim refused diff/); passed(push(d)); },
    'a failing git log denies, records error, no pass, no gate record': () => { const d = scanRepo(); clean(d); const r = push(d, shim('log')); refused(r, CLOSED, 'error'); assert.match(r.why, /fatal: shim refused log/); passed(push(d)); },
    'a scan error is not a split-the-push message': () => { const d = scanRepo(); clean(d); const why = push(d, shim('diff')).why; assert.match(why, CLOSED); assert.doesNotMatch(why, /split/i); },
    'a bad base object fails closed': () => { const d = scanRepo(); clean(d); const v = pushSecretScan(d, 'f'.repeat(40)); assert.equal(v.result, 'error'); assert.match(v.reason, CLOSED); assert.doesNotMatch(v.reason, /split/i); },
    'net diff over maxBuffer says split the push': () => { const d = scanRepo(); clean(d); const v = pushSecretScan(d, sh(d, 'git rev-parse origin/main'), 10); assert.equal(v.result, 'error'); assert.match(v.reason, CLOSED); assert.match(v.reason, /split the push into smaller pushes/); },
    'history log over maxBuffer says split the push': () => { const d = scanRepo(); sh(d, 'echo x > t && git add t && git commit -qm t && git rm -q t && git commit -qm rm'); assert.equal(sh(d, 'git diff origin/main..HEAD'), '', 'empty net diff'); const v = pushSecretScan(d, sh(d, 'git rev-parse origin/main'), 20); assert.equal(v.result, 'error'); assert.match(v.reason, /split the push into smaller pushes/); },
    'a generous limit does not overflow': () => { const d = scanRepo(); clean(d); assert.equal(pushSecretScan(d, sh(d, 'git rev-parse origin/main'), 1 << 20), null); },
    'a null or empty base fails closed': () => { const d = scanRepo(); addToken(d); for (const b of [null, undefined, '']) { const v = pushSecretScan(d, b); assert.equal(v?.result, 'error', `base ${b}`); assert.match(v.reason, CLOSED); } },
    ...Object.fromEntries(Object.entries(blinders).flatMap(([n, set]) => [
      [`${n} does not hide a secret in the tree`, () => { const d = scanRepo(); set(d); addToken(d); refused(push(d), NET, 'secret'); }],
      [`${n} does not hide a secret only in history`, () => { const d = scanRepo(); set(d); addRemove(d); refused(push(d), HISTORY, 'secret'); }],
      [`${n} does not hide a secret a merge adds, removed later`, () => { const d = scanRepo(); set(d); evilMerge(d); refused(push(d), HISTORY, 'secret'); }],
    ])),
    'a NUL byte in the file does not hide a secret in the tree': () => { const d = scanRepo(); sh(d, `${nulToken} > s.txt && git add s.txt && git commit -qm nul`); assert.equal(sh(d, 'git diff --numstat origin/main..HEAD').split('\t')[0], '-', 'git takes the file for binary'); refused(push(d), NET, 'secret'); },
    'a NUL byte in the file does not hide a secret only in history': () => { const d = scanRepo(); sh(d, `${nulToken} > s.txt && git add s.txt && git commit -qm nul && git rm -q s.txt && git commit -qm rm`); refused(push(d), HISTORY, 'secret'); },
    'a NUL byte in the file does not hide a secret a merge adds, removed later': () => { const d = scanRepo(); evilMerge(d, nulToken); refused(push(d), HISTORY, 'secret'); },
    'an octopus merge adding a secret to a -diff file, removed later, is denied': () => { const d = scanRepo(); diffOffTxt(d); side(d, 'o1'); side(d, 'o2'); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 o2 && echo "k=${TOKEN}" > merged.txt && git add merged.txt && git commit -qm evil && git rm -q merged.txt && git commit -qm remove`); refused(push(d), HISTORY, 'secret'); },
    'a merge editing a -diff file on both sides, secret in the resolution, is denied': () => { const d = scanRepo(); diffOffTxt(d); sh(d, `printf '1\\n' > f.txt && git add f.txt && git commit -qm f && git checkout -q -b o1 && printf '1\\no\\n' > f.txt && git add f.txt && git commit -qm o && git checkout -q feat/x && printf 'x\\n1\\n' > f.txt && git add f.txt && git commit -qm x; git merge -q --no-ff --no-commit o1; printf 'x\\n1\\no\\nk=${TOKEN}\\n' > f.txt; git add f.txt && git commit -qm evil`); dropLast(d, 'f.txt'); refused(push(d), HISTORY, 'secret'); },
    'lock-in: merging origin main into a -diff file keeps its token line without denying': () => {
      const d = scanRepo();
      diffOffTxt(d);
      sh(d, `printf '1\\n' > f.txt && git add f.txt && git commit -qm f && git checkout -q main && git merge -q --ff-only feat/x && printf '1\\nk=${TOKEN}\\n' > f.txt && git add f.txt && git commit -qm tok && git push -q origin main`);
      sh(d, `git checkout -q feat/x && printf '0\\n1\\n' > f.txt && git add f.txt && git commit -qm feat; git merge -q --no-ff --no-commit origin/main; printf '0\\n1\\nk=${TOKEN}\\n' > f.txt; git add f.txt && git commit -qm merge-main`);
      assert.match(sh(d, 'git log -1 --cc --text --format='), /^Binary files differ$/m, 'the case --cc cannot read');
      passed(push(d));
    },
    'lock-in: a clean merge adding a -diff file passes': () => { const d = scanRepo(); diffOffTxt(d); side(d, 'o1'); clean(d); sh(d, 'git merge -q --no-ff --no-commit o1 && echo clean > merged.txt && git add merged.txt && git commit -qm merge'); passed(push(d)); },
    'a binary in the net diff over maxBuffer denies and says split the push': () => { const d = scanRepo(); bigBinary(d); sh(d, 'git add big.bin && git commit -qm big'); const v = pushSecretScan(d, sh(d, 'git rev-parse origin/main'), 1 << 16); assert.equal(v?.result, 'error'); assert.match(v.reason, CLOSED); assert.match(v.reason, /split the push into smaller pushes/); },
    'a binary only in history over maxBuffer denies and says split the push': () => { const d = scanRepo(); bigBinary(d); sh(d, 'git add big.bin && git commit -qm big && git rm -q big.bin && git commit -qm rm'); assert.equal(sh(d, 'git diff origin/main..HEAD'), '', 'empty net diff'); const v = pushSecretScan(d, sh(d, 'git rev-parse origin/main'), 1 << 16); assert.equal(v?.result, 'error'); assert.match(v.reason, CLOSED); assert.match(v.reason, /split the push into smaller pushes/); },
    // The merge changes big.bin against both parents. Against feat/x that is the whole file, so only the per-parent read can overflow.
    'a merge of origin main whose per-parent read is over maxBuffer denies and says split the push': () => {
      const d = scanRepo(), limit = 1 << 16;
      diffOffTxt(d);
      sh(d, `printf '1\\n' > f.txt && git add f.txt && git commit -qm f && git checkout -q main && git merge -q --ff-only feat/x`);
      bigBinary(d);
      sh(d, `printf '1\\nm\\n' > f.txt && git add big.bin f.txt && git commit -qm big-on-main && git push -q origin main && git checkout -q feat/x && printf '0\\n1\\n' > f.txt && git add f.txt && git commit -qm feat; git merge -q --no-ff --no-commit origin/main; printf '0\\n1\\nm\\nresolved\\n' > f.txt; printf 'changed\\n' >> big.bin; git add f.txt big.bin && git commit -qm merge-main`);
      const base = sh(d, 'git rev-parse origin/main');
      assert.ok(changedAgainstAllParents(d, 'HEAD', 'big.bin'), 'the merge changes big.bin against every parent');
      assert.ok(sh(d, `git log -p --cc --text --full-history --format=%H ${base}..HEAD`).length < limit, 'the log itself fits, so only the per-parent read can overflow');
      const v = pushSecretScan(d, base, limit);
      assert.equal(v?.result, 'error'); assert.match(v.reason, CLOSED); assert.match(v.reason, /split the push into smaller pushes/);
    },
    'lock-in: merging origin main with a big file the merge leaves alone does not overflow': () => {
      const d = scanRepo(), limit = 1 << 16;
      sh(d, 'git checkout -q main');
      bigBinary(d);
      sh(d, `git add big.bin && git commit -qm big-on-main && git push -q origin main && git checkout -q feat/x && echo f > f && git add f && git commit -qm feat; git merge -q --no-ff --no-commit origin/main; echo resolved > m.txt; git add m.txt && git commit -qm merge-main`);
      assert.equal(pushSecretScan(d, sh(d, 'git rev-parse origin/main'), limit), null);
    },
    'lock-in: a plain merge of origin main with a big file reads no path and does not overflow': () => {
      const d = scanRepo(), limit = 1 << 16;
      sh(d, 'git checkout -q main');
      bigBinary(d);
      sh(d, 'git add big.bin && git commit -qm big-on-main && git push -q origin main && git checkout -q feat/x && echo f > f && git add f && git commit -qm feat && git merge -q --no-ff -m merge-main origin/main');
      assert.ok(!sh(d, 'git diff-tree -c --name-only --no-commit-id HEAD'), 'the merge changes no path against every parent');
      assert.equal(pushSecretScan(d, sh(d, 'git rev-parse origin/main'), limit), null);
    },
    'a NUL before the token, past byte 8000, does not hide a secret a merge adds, removed later': () => {
      const d = scanRepo();
      evilMerge(d, lateNulToken);
      const cc = sh(d, 'git log -1 -p --cc --format= HEAD~1');
      assert.doesNotMatch(cc, /^Binary files /m, 'git takes the file for text');
      assert.deepEqual(secretsInDiff(cc), [], '--cc cuts the line at the NUL');
      assert.ok(changedAgainstAllParents(d, 'HEAD~1', 'merged.txt'), 'the path list names the file');
      refused(push(d), HISTORY, 'secret');
    },
    'a merge adding a secret to an awkwardly named file, removed later, is denied': () => {
      for (const name of ['m[x].txt', 'a\\012b.txt', 'f\\377.txt', 'sp ace/*.txt', ':(top)x.txt']) {
        const d = scanRepo();
        side(d, 'o1'); clean(d);
        sh(d, `n=$(printf '${name}') && git merge -q --no-ff --no-commit o1 && mkdir -p "$(dirname "$n")" && ${lateNulToken} > "$n" && git add -- ":(literal)$n" && git commit -qm evil && git rm -q -- ":(literal)$n" && git commit -qm remove`);
        refused(push(d), HISTORY, 'secret');
      }
    },
    'lock-in: a merge adding a token to a *.lock or *.snap file stays out of the scan': () => { const d = scanRepo(); side(d, 'o1'); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 && ${lateNulToken} > x.lock && ${lateNulToken} > y.snap && git add x.lock y.snap && git commit -qm evil`); passed(push(d)); },
    'lock-in: a clean evil-shaped merge is allowed': () => { const d = scanRepo(); side(d, 'o1'); clean(d); sh(d, 'git merge -q --no-ff --no-commit o1 && echo fine > merged.txt && git add merged.txt && git commit -qm merge'); passed(push(d)); },
    ...Object.fromEntries([64, 65].map((n) => [`a ${n}-parent octopus adding a secret in a new file, removed later, is denied`, () => {
      const d = scanRepo(), base = sh(d, 'git rev-parse origin/main');
      octopus(d, n, `k=${TOKEN}`);
      assert.ok(changedAgainstAllParents(d, 'HEAD', 'merged.txt'), 'the path list names the file');
      sh(d, 'git rm -q merged.txt && git commit -qm remove');
      assert.deepEqual(secretsInDiff(sh(d, `git log -p --cc --format= ${base}..HEAD`)), [], '--cc has no all-plus column at this width');
      const r = push(d);
      assert.ok(r.why, 'denied'); assert.ok(!r.recorded, 'no gate record');
    }])),
    'a 64-parent merge with no secret is denied and says to split it': () => { const d = scanRepo(); octopus(d, 64, 'fine'); refusedWide(d); },
    'a 64-parent merge equal to all its parents is denied too': () => { const d = scanRepo(); octopus(d, 64); refusedWide(d); },
    'a 63-parent octopus adding a secret, removed later, is denied': () => { const d = scanRepo(); octopus(d, 63, `k=${TOKEN}`); sh(d, 'git rm -q merged.txt && git commit -qm remove'); refused(push(d), HISTORY, 'secret'); },
    'lock-in: a clean 63-parent octopus is allowed': () => { const d = scanRepo(); octopus(d, 63, 'fine'); passed(push(d)); },
    'a shallow boundary does not hide a token in the commit behind it, before or after unshallowing': () => {
      const d = scanRepo(), mirror = join(makeScratch('harness-mirror-'), 'm.git');
      addRemove(d);
      sh(d, `git clone -q --no-local --mirror . "${mirror}" && git fetch -q --depth=1 "file://$PWD" feat/x`);
      assert.equal(sh(d, 'git rev-parse --is-shallow-repository'), 'true', 'the head is a shallow boundary');
      assert.deepEqual(secretsInDiff(sh(d, 'git log -p --cc --format= HEAD')), [], 'the boundary hides the token from a plain git log');
      refused(push(d), HISTORY, 'secret');
      sh(d, `git fetch -q --unshallow "${mirror}" feat/x`);
      assert.equal(sh(d, 'git rev-parse --is-shallow-repository'), 'false', 'unshallowed');
      refused(push(d), HISTORY, 'secret');
    },
    'a genuinely shallow clone whose range reaches the boundary fails closed': () => {
      const d = scanRepo(), clone = join(makeScratch('harness-shallow-'), 'c');
      addRemove(d); sh(d, 'git push -q origin feat/x');
      sh(d, `git clone -q --depth=1 --branch feat/x "file://$PWD.origin.git" "${clone}"`);
      sh(clone, 'git config user.email t@t && git config user.name t && git fetch -q --depth=1 origin main:refs/remotes/origin/main');
      clean(clone, 'more');
      refused(push(clone), CLOSED, 'error');
    },
    'a genuinely shallow clone with commits above the base still scans them': () => {
      const d = scanRepo(), clone = join(makeScratch('harness-shallow-'), 'c');
      sh(d, 'git push -q origin feat/x');
      sh(d, `git clone -q --depth=1 --branch main "file://$PWD.origin.git" "${clone}"`);
      sh(clone, 'git config user.email t@t && git config user.name t && git checkout -q -b feat/x');
      clean(clone, 'more');
      passed(push(clone));
      addToken(clone);
      refused(push(clone), NET, 'secret');
    },
    // SID-244 narrowed this: the override stays when the repo has a shallow file, and goes when it has none (scripts/test-diff-guard.mjs).
    'gate commands run with the shallow file off in a repo that has one': () => { const d = scanRepo({ gate: ['test "$GIT_SHALLOW_FILE" = /dev/null'] }); clean(d); writeFileSync(join(gitDirOf(d), 'shallow'), `${sh(d, 'git rev-parse origin/main')}\n`); passed(push(d)); },
    'log.showSignature does not run gpg.program during the scan': () => {
      const d = scanRepo(), { marker, program } = fakeGpg(d);
      sh(d, `echo c > c && git add c && git -c gpg.program="${program}" commit -S -qm signed && git config gpg.program "${program}" && git config log.showSignature true`);
      assert.match(sh(d, 'git cat-file commit HEAD'), /^gpgsig /m, 'a signed commit');
      sh(d, 'git log -1');
      assert.ok(existsSync(marker), 'a plain git log runs the program');
      rmSync(marker);
      passed(push(d));
      assert.ok(!existsSync(marker), 'the scan did not run it');
    },
    // Tips come from the object itself, so the graph lies about a commit below them.
    'a commit-graph with rewritten parents does not hide a token commit': () => {
      const d = scanRepo(), base = sh(d, 'git rev-parse origin/main');
      addRemove(d); clean(d);
      poisonGraph(d, [[sh(d, 'git rev-parse HEAD~1'), base]]);
      assert.deepEqual(secretsInDiff(sh(d, `git log -p --cc --format= ${base}..HEAD`)), [], 'the graph hides the added line from a plain git log');
      refused(push(d), HISTORY, 'secret');
    },
    'a commit-graph giving a false merge-base does not change the base': () => {
      const d = scanRepo({ gate: ['echo base={base}'] }), base = sh(d, 'git rev-parse origin/main'), older = sh(d, 'git rev-parse origin/main~1');
      clean(d, 'one'); const one = head(d); clean(d, 'two'); const two = head(d); clean(d, 'three');
      poisonGraph(d, [[one, older], [older, two]], { [base]: 20, [older]: 19 });
      assert.notEqual(sh(d, `git merge-base HEAD ${base} || echo none`), base, 'the graph gives a false merge-base, or none');
      const r = push(d); passed(r);
      assert.ok(r.runs.some((x) => x.command === `echo base=${base}`), `base is ${base}: ${JSON.stringify(r.runs)}`);
    },
    'textconv output is scanned in the tree': () => { const d = scanRepo(); textconvFile(d); assert.deepEqual(secretsInDiff(sh(d, 'git diff --no-textconv origin/main..HEAD')), [], 'the raw file holds no token'); refused(push(d), NET, 'secret'); },
    'color.ui=always does not hide textconv output': () => { const d = scanRepo(); sh(d, 'git config color.ui always'); textconvFile(d); refused(push(d), NET, 'secret'); },
    'a failing textconv driver fails closed': () => { const d = scanRepo(); textconvFile(d, 'false'); refused(push(d), CLOSED, 'error'); },
    'history is not read with textconv: a driver for a file only in history does not run': () => {
      const d = scanRepo(), ran = join(gitDirOf(d), 'conv-ran');
      textconvFile(d, script(d, 'conv', `: > "${ran}"\nexec base64 -d "$1"`));
      sh(d, 'git rm -q k.b64 && git commit -qm remove');
      passed(push(d));
      assert.ok(!existsSync(ran), 'the driver did not run');
    },
    'a diff.external printing a token still denies the push, as on main': () => { const d = scanRepo(); clean(d); const x = script(d, 'loud-diff', `echo '+k=${TOKEN}'`); sh(d, `git config diff.external "${x}"`); refused(push(d), NET, 'secret'); },
    'lock-in: a binary under the limit passes the scan': () => { const d = scanRepo(); bigBinary(d); sh(d, 'git add big.bin && git commit -qm big'); assert.equal(pushSecretScan(d, sh(d, 'git rev-parse origin/main'), 1 << 23), null); },
    'a .git/info/grafts cycle over two token commits is denied': () => {
      const d = scanRepo(), base = sh(d, 'git rev-parse origin/main');
      sh(d, `echo "k=${TOKEN}" > s.txt && git add s.txt && git commit -qm t1 && git commit -q --allow-empty -m t2 && git rm -q s.txt && git commit -qm rm`);
      const t1 = sh(d, 'git rev-parse HEAD~2'), t2 = sh(d, 'git rev-parse HEAD~1');
      writeFileSync(join(gitDirOf(d), 'info', 'grafts'), `${t1} ${t2}\n${t2} ${t1}\n`);
      assert.deepEqual(secretsInDiff(logWithoutGraftOverride(d, `${base}..HEAD`)), [], 'the grafts hide the added line from a plain git log');
      refused(push(d), HISTORY, 'secret');
    },
    'a graft cutting the token commits out of the walk is denied': () => {
      const d = scanRepo(), base = sh(d, 'git rev-parse origin/main');
      addRemove(d);
      writeFileSync(join(gitDirOf(d), 'info', 'grafts'), `${head(d)} ${base}\n`);
      assert.deepEqual(secretsInDiff(logWithoutGraftOverride(d, `${base}..HEAD`)), [], 'the graft hides the added line from a plain git log');
      refused(push(d), HISTORY, 'secret');
    },
    'gate commands run with grafts off and the real merge-base': () => { const d = scanRepo({ gate: ['test "$GIT_GRAFT_FILE" = /dev/null', 'test "$GIT_NO_REPLACE_OBJECTS" = 1', 'echo base={base}'] }), mb = head(d); clean(d); const real = head(d); clean(d, 'second'); writeFileSync(join(gitDirOf(d), 'info', 'grafts'), `${real} ${sh(d, 'git rev-parse origin/main~1')}\n`); const r = push(d); passed(r); assert.ok(r.runs.some((x) => x.command === `echo base=${mb}`), `base is ${mb}: ${JSON.stringify(r.runs)}`); },
    'an old-style record does not skip the scan': () => { const d = scanRepo(); addToken(d); oldRecord(d); refused(push(d), NET, 'secret'); },
    'an old-style record does not skip the scan of history': () => { const d = scanRepo(); addRemove(d); oldRecord(d); refused(push(d), HISTORY, 'secret'); },
    'an old-style record does not skip the gate commands': () => { const d = scanRepo({ gate: ['false'] }); clean(d); oldRecord(d); const r = push(d); assert.match(r.why, /harness gate failed: `false`/); assert.ok(!r.recorded, 'no new record'); },
    'a clean head with an old-style record re-runs the gate once, then the new record skips it': () => { const d = scanRepo(); clean(d); oldRecord(d); const r = push(d); passed(r); assert.equal(r.runs.filter((x) => x.result === 'pass').length, 1, 'the gate ran'); assert.equal(push(d).runs.filter((x) => x.result === 'pass').length, 1, 'recorded head skips the gate'); },
    'Stop does not take an old-style record for a passed gate': () => { const d = scanRepo(); clean(d); oldRecord(d); assert.match(stopReason(d), /the gate in \.harness\.json has not passed for HEAD/); },
    'Stop takes the new record for a passed gate': () => { const d = scanRepo(); clean(d); passed(push(d)); assert.doesNotMatch(stopReason(d), /has not passed for HEAD/); },
    'first push: token added then removed is denied': () => { const d = scanRepo(); addRemove(d); const r = push(d); refused(r, HISTORY, 'secret'); assert.match(r.why, /rewriting those commits \(a human step\)/); assert.doesNotMatch(r.why, /--no-verify|core\.hooksPath|bypass/); },
    'rewritten branch: new range holding add and remove is denied': () => { const d = scanRepo(); clean(d, 'first'); passed(push(d)); sh(d, 'git push -q origin feat/x && git reset -q --hard HEAD~1'); clean(d, 'second'); addRemove(d); refused(push(d), HISTORY, 'secret'); },
    'evil merge adding a new file, removed later, is denied': () => { const d = scanRepo(); side(d, 'o1'); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 && echo "k=${TOKEN}" > merged.txt && git add merged.txt && git commit -qm evil && git rm -q merged.txt && git commit -qm remove`); refused(push(d), HISTORY, 'secret'); },
    'evil merge editing a file, line removed later, is denied': () => { const d = scanRepo(); side(d, 'o1'); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 && echo "k=${TOKEN}" >> a && git add a && git commit -qm evil`); dropLast(d, 'a'); refused(push(d), HISTORY, 'secret'); },
    'octopus evil merge, line removed later, is denied': () => { const d = scanRepo(); side(d, 'o1'); side(d, 'o2'); clean(d); sh(d, `git merge -q --no-ff --no-commit o1 o2 && echo "k=${TOKEN}" >> a && git add a && git commit -qm evil`); assert.equal(sh(d, 'git rev-list --parents -n1 HEAD').split(' ').length, 4, 'three parents'); dropLast(d, 'a'); refused(push(d), HISTORY, 'secret'); },
    'a side branch whose merge leaves the tree unchanged is still read': () => { const d = scanRepo(); sh(d, 'git checkout -q -b leak'); addRemove(d); sh(d, 'git checkout -q feat/x'); clean(d); sh(d, 'git merge -q --no-ff -m merge-leak leak'); refused(push(d), HISTORY, 'secret'); },
    'log.showroot=false does not hide a root commit in the range': () => { const d = scanRepo(); sh(d, `git config log.showroot false && git checkout -q --orphan feat/y && git rm -qrf . && echo "k=${TOKEN}" > s.txt && git add s.txt && git commit -qm root && git rm -q s.txt && echo a > a && git add a && git commit -qm clean && git branch -qf feat/x && git checkout -q feat/x`); refused(push(d), HISTORY, 'secret'); },
    'an added line starting with ++ is read, not taken for a header': () => { const d = scanRepo(); sh(d, `echo "++k=${TOKEN}" > p.txt && git add p.txt && git commit -qm plus`); refused(push(d), NET, 'secret'); },
    'an added ++ line only in history is read': () => { const d = scanRepo(); sh(d, `echo "++k=${TOKEN}" > p.txt && git add p.txt && git commit -qm plus && git rm -q p.txt && git commit -qm rm`); refused(push(d), HISTORY, 'secret'); },
    'lock-in: a secret in the tree keeps the net message': () => { const d = scanRepo(); addToken(d); refused(push(d), NET, 'secret'); },
    'lock-in: base is the merge-base with origin main on first and later pushes': () => {
      const d = scanRepo({ gate: ['echo base={base}'] }), mb = head(d);
      sh(d, 'git checkout -q main && echo m > m && git add m && git commit -qm m && git push -q origin main && git checkout -q feat/x');
      assert.notEqual(sh(d, 'git rev-parse origin/main'), mb, 'origin main moved past the branch point');
      clean(d, 'one'); passed(push(d)); assert.ok(gateRuns(d, head(d)).some((x) => x.command === `echo base=${mb}`), 'first push (before = zeros) uses the merge-base');
      sh(d, 'git push -q origin feat/x'); clean(d, 'two'); passed(push(d)); assert.ok(gateRuns(d, head(d)).some((x) => x.command === `echo base=${mb}`), 'a later push uses the same merge-base, not the pushed before');
    },
    'lock-in: *.lock and *.snap stay out of both scans': () => { const d = scanRepo(); addToken(d, 'x.lock'); addToken(d, 'y.snap'); sh(d, 'git rm -q y.snap && git commit -qm rm-snap'); passed(push(d)); },
    'lock-in: a clean branch passes': () => { const d = scanRepo(); clean(d); const r = push(d); passed(r); assert.ok(r.runs.some((x) => x.result === 'pass')); },
    'lock-in: a token already on origin main does not deny the feature push': () => { const d = scanRepo(); sh(d, `git checkout -q main && echo "k=${TOKEN}" > onmain.txt && git add onmain.txt && git commit -qm tok && git push -q origin main && git checkout -q -B feat/x main`); clean(d); passed(push(d)); },
    // Both sides edit the same line and the resolution keeps both, so --cc shows main's token line with a one-column `+ ` prefix. It came from a parent already on origin.
    'lock-in: merging origin main, a resolution keeping its token line does not deny': () => {
      const d = scanRepo();
      sh(d, `printf '1\\n' > f.txt && git add f.txt && git commit -qm f && git checkout -q main && git merge -q --ff-only feat/x && printf '1\\nk=${TOKEN}\\n' > f.txt && git add f.txt && git commit -qm tok && git push -q origin main`);
      sh(d, `git checkout -q feat/x && printf '1\\nfeat\\n' > f.txt && git add f.txt && git commit -qm feat; git merge -q --no-ff origin/main; printf '1\\nfeat\\nk=${TOKEN}\\n' > f.txt && git add f.txt && git commit -qm merge-main`);
      assert.equal(sh(d, 'git rev-list --parents -n1 HEAD').split(' ').length, 3, 'a merge commit');
      assert.match(sh(d, 'git log -1 --cc --format='), /^\+ k=AKIA/m, '--cc shows the one-column prefix this case is about');
      passed(push(d));
    },
  };
  const failed = [];
  for (const [name, fn] of Object.entries(cases)) {
    try { fn(); console.log(`ok   SID-213 ${name}`); }
    catch (e) { failed.push(name); console.log(`FAIL SID-213 ${name}: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
  }
  assert.deepEqual(failed, [], 'SID-213 cases');
}

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
  // text written to a file can run later (hooks, .husky, scripts, git config): lines that write files keep main's quote-blind scan
  String.raw`echo "$(printf '[core]\n\tpager = true; git reset --hard\n' >> .git/config)" && git log`, String.raw`printf '[core]\n\tpager = true; git reset --hard\n' >> ~/.gitconfig && git log`,
  String.raw`printf 'true; git reset --hard\n' > .husky/pre-commit && git commit -m x`, String.raw`printf 'true; git reset --hard\n' > run.sh`, "printf 'x; git branch -D main' | tee run.sh",
  String.raw`printf '%s\n' 'true; git reset --hard' > .githooks/pre-commit && git commit -m x`,
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
  "printf 'ok' > notes.md && git commit -m 'docs: notes'", 'echo "a; b" > /dev/null', "echo 'x; y' | tee /dev/null", 'git log --oneline > /tmp/sflow-log.txt', 'cat ~/.gitconfig', 'git config --global --get user.name', 'echo "$(git rev-parse HEAD)" > .last-sha',
  'git replace -l', 'git replace --list', 'git symbolic-ref -q HEAD', 'git symbolic-ref HEAD refs/heads/feat/x', 'git symbolic-ref -m switch HEAD refs/heads/feat/x',
  'git config --get core.bare', 'git config core.bare', 'git config --get-all include.path', 'git config -l', 'git config core.autocrlf false', 'git -c core.autocrlf=false status', 'git push origin feat/x:feat/y', 'git push origin HEAD:refs/heads/feat/x',
  'git push origin feat/x', 'git push -u origin feat/x', // SID-65: branch known and named, stays allowed
  ...allowRemote, // SID-65: remote-tracking rules must not touch ordinary fetch/pull/config/gh reads
  // SID-107: text piped into a shell is checked, but ordinary pipes into sh / tee / xargs are not
  'curl -fsSL https://example.com/i.sh | sh', 'echo ls | sh', 'echo hi | tee >(wc -l)', "find . -name '*.md' | xargs -I{} git add {}", "printf 'echo hi\\n' | sh", "echo 'git status' | sh", 'cat script.sh | bash', 'git log --oneline | head',
  // SID-108: quoted globs are literal, and a glob not at the start of a git word cannot match a name that starts with `-`
  'eval "$(ssh-agent -s)"', 'eval "$(fnm env)"', 'source <(kubectl completion bash)', 'sh -c "$(curl -fsSL https://example.com/i.sh)"', "echo hi | xargs -I{} sh -c 'echo {}'", 'source ~/.bashrc', '. ./env.sh', // SID-107 follow-up
  "git push origin 'feat/*'", "git fetch origin 'refs/heads/*:refs/heads/*'", "git log -- '*.mjs'", 'ls [-]*', // SID-191 re-review: unquoted git push origin feat/* and git add *.mjs are now denied (sid191LiteralCollateral)
];
for (const c of mustAllow) assert.ok(!denied('pre-bash.mjs', bash(c)), `must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);

// SID-191: shell quoting, backslashes and adjacent pieces of one word can't split a guarded word. Each of these was allowed on main 91c6b08.
const sid191Cfg = { protectedBranches: ['main', 'master'], allowMerge: false };
const guardDenies = (c, b = 'feat/x') => Boolean(newRules.lineReason(c) || newRules.segmentReason(c, sid191Cfg, b));
const sid191 = ['gh pr "merge" 1', 'g""h pr merge 1', 'git push "--for"ce origin feat/x', 'git push origin "ma"in', 'git push origin ma\\in', 'git commit --no-"verify" -m x', 'git reset --"hard" HEAD~1', 'git -c "core.hooks"Path=/tmp/planted commit -m x'];
for (const c of sid191) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-191 must deny: ${c}`);
const sid191More = [
  "$'\\x67it' push origin main", "git push origin $'ma\\151n'", "g\\h pr merge 1", "'gh' 'pr' 'merge' 1", 'git re"set" --ha\'rd\'', 'git -c core."hooksPath"=/tmp/p commit -m x', "git -c 'core.hooksPath=/tmp/p' commit -m x",
  'echo "$(g""h pr merge 1)"', "sh -c 'g\"\"h pr merge 1'", "bash -c 'git push origin \"ma\"in'", 'echo \'g""h pr merge 1\' | sh', 'git br""anch -D x', 'git cl"ean" -fd', 'git stash "drop"', 'gh api -X "PUT" repos/o/r/pulls/1/merge', 'n""pm publish',
  'git "push" origin HEAD:"main"', 'git push origin +"feat/x"', 'git push "--mirror"', 'git update-ref --"stdin"', 'git config core."bare" true', 'HU""SKY=0 git commit -m x', 'git commit -"n" -m x',
  // fail closed: what can't be read where it could change a guarded command
  "echo 'unclosed", 'echo "unclosed', 'echo $(unclosed', 'echo `unclosed', 'X=--hard; git reset $X', 'X=main; git push origin $X', 'C="git push -f"; $C', 'export M=merge; gh pr $M 1',
  'git reset "$X"', 'git reset $X', 'git $SUB -f', '$G push -f', '${G} reset --hard', '$(which git) push -f origin feat/x', 'gh pr $X 1', 'gh $X merge 1', 'gh api $M repos/o/r', 'gh api repos/$R/pulls', 'git branch $F x', 'git clean $F', 'git checkout $X', 'git stash $X',
  'git -c "$K"=x status', 'git -c core.$K=x status', 'git --config-env=$K status', 'GIT_CONFIG_PARAMETERS="$X" git status', 'GIT_CONFIG_KEY_0=$K GIT_CONFIG_VALUE_0=x GIT_CONFIG_COUNT=1 git status', 'eval $X', 'eval "$CMD"', 'git commit $FLAGS -m x',
  'git checkout "$(echo .)"', 'git checkout `echo .`', 'echo "$(git reset "$X")"', 'git checkout -b $Y', 'git -c core.hooksPath=$X commit -m x',
  '$CMD push', '$CMD push origin feat/x', '${G} commit -m x', '$GH pr merge 1', '$GH repo edit', '$X publish', '$A $B', '"$CMD" reset', 'gh workflow $X ci.yml', 'gh repo $X o/r',
];
for (const c of sid191More) for (const b of ['feat/x', 'main']) assert.ok(guardDenies(c, b), `SID-191 must deny on ${b}: ${c}`);
const sid191Allow = [
  'git commit -m "$MSG"', 'git commit -m "fix: $X"', 'git log --format="%H $X"', 'gh pr create --title "$T" --body "$B"', 'gh pr create --fill --base "$BASE"', 'git add "$F"', 'git -C "$DIR" status', 'git diff $BASE...HEAD', 'git log $BASE..HEAD --oneline',
  'git rev-parse $X', 'gh pr view $N', 'gh api "repos/$R/pulls"', 'gh issue comment 3 --body "$(cat notes.md)"', 'eval "$(ssh-agent -s)"', 'echo "it\'s"', "echo 'a \"b\" c'", 'npm run "test"', 'git push -u origin "feat/x"', "git push -u origin 'feat/x'",
  'git commit -m "$(cat <<\'EOF\'\nfix: handle "quoted" it\'s (x)\nEOF\n)"', 'gh pr create --title "x" --body "$(cat <<\'EOF\'\n## Summary\n- a "b" (c)\nEOF\n)"', 'cat <<EOF > notes.md\nit\'s "x\nEOF', 'echo $HOME', 'cd "$(git rev-parse --show-toplevel)" && git status',
  'X=$(git rev-parse HEAD) && echo "$X"', 'for f in *.md; do echo "$f"; done', 'git commit -m "a \\"quoted\\" word"', 'echo \\"hi\\"', 'git status # it\'s fine',
];
// The price of failing closed (collateral, measured against main 91c6b08, which allows every one): an expansion in a git argument that a probe
// shows could be a denied value, and a message that is exactly a flag. Write the value out literally instead.
const sid191Collateral = ['git checkout $BRANCH', 'git checkout "$BRANCH"', 'git switch "$BRANCH"', 'git restore "$F"', 'git restore --staged "$F"', 'git reset $SHA', 'git reset --soft "$SHA"', 'git merge $B', 'git branch -d $B',
  'git fetch origin "$BRANCH"', 'git pull origin "$BRANCH"', 'gh api repos/$R/pulls', 'git commit -m "--no-verify"', 'git commit -m "-n"', 'git reset "$(git merge-base HEAD origin/main)"', 'git checkout "$(git rev-parse --abbrev-ref HEAD)"', "echo it's",
  'git config user.name "$NAME"'] // since #24 a `-e` anywhere in git config opens the editor, and a quoted "$NAME" could be -e;
for (const c of sid191Collateral) assert.ok(guardDenies(c), `SID-191 collateral (documented, fails closed): ${c}`);
const sid191Kept = ['git switch -c "$BRANCH"', 'git checkout -b "$BRANCH"', 'git merge --ff-only "origin/$B"', 'git rebase "origin/$BASE"', 'gh pr checkout $N', 'gh run view $RUN --log', 'git cherry-pick "$SHA"', 'git worktree add "../wt-$N" -b "$B"', 'git stash push -m "$MSG"', 'git clone "$URL"', 'gh pr edit $N --add-label "$L"', 'git branch --merged | grep -v main | xargs git branch -d', 'echo $HOME', 'cd "$D" && ls']; // SID-191 re-review: expansion command words moved to sid191LiteralCollateral
for (const c of sid191Kept) assert.ok(!guardDenies(c), `SID-191 must allow: ${c} (${newRules.segmentReason(c, sid191Cfg, 'feat/x')?.why})`);
for (const c of sid191Allow) assert.ok(!guardDenies(c), `SID-191 must allow: ${c} (${newRules.lineReason(c) ?? newRules.segmentReason(c, sid191Cfg, 'feat/x')?.why})`);
// Generated quote-split suite: every word of each guarded command, split in the middle (or wholly wrapped) by each quoting style, stays denied.
const SPLIT_BODIES = ['git push --force origin feat/x', 'git push origin main', 'git push origin HEAD:main', 'git push --mirror', 'git reset --hard HEAD~1', 'git branch -D x', 'git clean -fdx', 'git checkout .', 'git commit --no-verify -m x', 'git stash clear',
  'gh pr merge 1', 'gh api -X PUT repos/o/r/pulls/1/merge', 'npm publish', 'git -c core.hooksPath=/tmp/p commit -m x', 'git update-ref --stdin', 'git config core.bare true', 'HUSKY=0 git commit -m x', 'git filter-branch --all'];
const STYLES = [(a, b) => `"${a}"${b}`, (a, b) => `${a}"${b}"`, (a, b) => `'${a}'${b}`, (a, b) => `${a}'${b}'`, (a, b) => `${a}\\${b}`, (a, b) => `${a}""${b}`, (a, b) => `${a}''${b}`, (a, b) => `$'${a}'${b}`, (a, b) => `"${a}"'${b}'`, (a, b) => `"${a}${b}"`, (a, b) => `'${a}${b}'`];
const splitVariants = [];
for (const body of SPLIT_BODIES) {
  const ws = body.split(' ');
  ws.forEach((w, k) => {
    if (w.length < 2) return;
    const m = Math.ceil(w.length / 2);
    for (const st of STYLES) splitVariants.push([...ws.slice(0, k), st(w.slice(0, m), w.slice(m)), ...ws.slice(k + 1)].join(' '));
  });
}
for (const c of splitVariants) for (const b of ['feat/x', 'main']) assert.ok(guardDenies(c, b), `SID-191 quote-split variant must deny on ${b}: ${c}`);
for (const c of splitVariants.filter((_, k) => k % 37 === 0)) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-191 quote-split variant must deny through the hook: ${c}`);
console.log(`SID-191: ${sid191.length} reported + ${sid191More.length} more must-deny, ${sid191Allow.length} must-allow, ${splitVariants.length} generated quote-split variants x 2 branches denied`);
// SID-191 review (B1-B5 on b3b69f9): the reported forms, then generated variants of every SPLIT_BODIES command. Each was allowed on b3b69f9.
const sid191Review = [
  "bash -c 'gh pr '\\''merge'\\'' 1'", "bash -c 'git reset '\\''--hard'\\'' HEAD~1'", "bash -c 'git push origin '\\'''\\''main'", "bash -c 'git commit '\\''--no-verify'\\'' -m x'",
  "bash -c 'git -c c\"ore.hooksPath=/tmp/h\" commit -m x'", "bash -c 'git -c \\c\\o\\r\\e\\.\\h\\o\\o\\k\\s\\P\\a\\t\\h\\=/tmp/h commit -m x'", // B1
  'git -c c\\\nore.hooksPath=/tmp/h commit -m x', 'git -c core.hooks\\\nPath=/tmp/h commit -m x', // B2
  'gh pr {merge,1}', 'git reset {--hard,HEAD~1}', 'git commit {--no-verify,-m} x', 'git {push,origin} main', 'git push origin {main,feat}', 'g{h,} pr merge 1', // B3
  'touch -- --hard && git reset --har? HEAD~1', 'touch merge; gh pr m?rge 1', 'touch main && git push origin ma?n', 'git push origin m[a]in', 'git reset -[-]hard', 'git commit -[-]no-verify', 'gh api -X P[U]T repos/o/r/pulls/1/merge', 'g?t push origin main', // B4
  'npm ${X:-publish}', 'npm "$(printf %s publish)"', 'npm `echo publish`', 'pnpm $X', 'yarn ${C}', 'p(){ "$@"; }; p gh pr merge 1', 'p(){ "$@"; }; p git push origin main', 'function p { $@; }; p git reset --hard', "bash -c 'eval \"$1\"' _ 'gh pr merge 1'", "sh -c '$1 $2 $3 $4' _ git push origin main", "bash -c '\"$@\"' _ git reset --hard", // B5
  "eval 'gh pr '\\''merge'\\'' 1'", "eval 'git -c c\"ore.hooksPath=/tmp/h\" commit -m x'", "env bash -c 'gh pr '\\''merge'\\'' 1'", "timeout 5 sh -c 'git reset '\\''--hard'\\''", "nice -n 5 bash -c 'git -c c\"ore.hooksPath=/tmp/h\" commit'", // B1 through eval and wrappers
  'git -c "core.hooks\\\nPath=/tmp/p" commit -m x', // a backslash-newline inside double quotes joins the word (pins canon's double-quote escape handling)
  Array(10).fill(0).reduce((s) => `bash -c '${s.replace(/'/g, `'\\''`)}'`, 'git status'), // nested past PAYLOAD_DEPTH: fails closed
];
for (const c of sid191Review) for (const b of ['feat/x', 'main']) assert.ok(guardDenies(c, b), `SID-191 review must deny on ${b}: ${c}`);
for (const c of sid191Review.filter((_, k) => k % 4 === 0)) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-191 review must deny through the hook: ${c}`);
const sid191ReviewAllow = ['ls *.md', 'echo {a,b}', "git commit -m 'fix {a,b}'", 'git commit -m "x {a,b} *"', "git log --format='{%H}'", 'gh pr view 1', 'npm test', 'npm run build', 'npm "test"',
  "bash -c 'npm test'", 'f(){ echo "$@"; }; f a b', "bash -c 'git status'", Array(3).fill(0).reduce((s) => `bash -c '${s.replace(/'/g, `'\\''`)}'`, 'git status'), 'eval "$(ssh-agent -s)"'];
for (const c of sid191ReviewAllow) assert.ok(!guardDenies(c), `SID-191 review must allow: ${c} (${newRules.lineReason(c) ?? newRules.segmentReason(c, sid191Cfg, 'feat/x')?.why})`);
const sqr = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const GLOB_WORDS = new Set(['push', 'reset', 'clean', 'branch', 'stash', 'commit', 'checkout', 'config', 'update-ref', 'filter-branch', 'pr', 'api', 'merge', 'publish', 'PUT', 'main', '--force', '--hard', '--no-verify', '--mirror', '--stdin', '-D', 'clear']);
const reviewVariants = [];
for (const body of SPLIT_BODIES) {
  const ws = body.split(' ');
  reviewVariants.push(`bash -c ${sqr(body)}`, `sh -c 'eval "$1"' _ ${sqr(body)}`, `bash -c '"$@"' _ ${body}`, `p(){ "$@"; }; p ${body}`, `bash -c ${sqr(`bash -c ${sqr(body)}`)}`);
  ws.forEach((w, k) => {
    const at = (x) => [...ws.slice(0, k), x, ...ws.slice(k + 1)].join(' ');
    reviewVariants.push(`bash -c ${sqr(at(`'${w}'`))}`, `bash -c ${sqr(at(`\\${w}`))}`, at(`{${w},${w}}`)); // B1 quoting inside a payload, B3 braces
    if (w.length >= 2) { const m = Math.ceil(w.length / 2); reviewVariants.push(at(`${w.slice(0, m)}\\\n${w.slice(m)}`)); } // B2 continuation inside the word
    if (GLOB_WORDS.has(w)) reviewVariants.push(at(`${w.slice(0, -1)}?`), at(`${w.slice(0, 1)}[${w[1]}]${w.slice(2)}`), at(`${w.slice(0, 2)}*`)); // B4
  });
}
for (const c of reviewVariants) for (const b of ['feat/x', 'main']) assert.ok(guardDenies(c, b), `SID-191 review variant must deny on ${b}: ${c}`);
for (const c of reviewVariants.filter((_, k) => k % 41 === 0)) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-191 review variant must deny through the hook: ${c}`);
console.log(`SID-191 review: ${sid191Review.length} must-deny, ${sid191ReviewAllow.length} must-allow, ${reviewVariants.length} generated variants x 2 branches denied`);
// SID-191 review item 8: a deny bigger than a pipe buffer must still arrive whole (was 65,536 bytes of invalid JSON and exit 0 on main).
{
  const slowPipe = (hookFile, ev) => { const f = join(makeScratch('harness-bigdeny-'), 'ev.json'); writeFileSync(f, JSON.stringify(ev)); return execFileSync('sh', ['-c', `node "${join(hooks, hookFile)}" < "${f}" | (sleep 0.3; cat)`], { cwd: ev.cwd, maxBuffer: 1 << 26 }).toString(); };
  const nest = (n) => Array(n).fill(0).reduce((s) => `bash -c '${s.replace(/'/g, `'\\''`)}'`, 'gh pr merge 1');
  for (const c of [`gh pr merge 1 --body ${'a'.repeat(70000)}`, `git push origin main ${'x'.repeat(200000)}`, nest(13)]) {
    const out = slowPipe('pre-bash.mjs', bash(c));
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny', `item 8: a ${c.length}-char command must deny with whole JSON over a slow pipe`);
    assert.ok(out.length < 8192, `item 8: the deny echoes a capped command (${out.length} bytes)`);
  }
  // emit() itself writes everything synchronously, however big
  const emitOut = execFileSync('sh', ['-c', `node --input-type=module -e 'import { emit } from "${join(hooks, 'lib.mjs')}"; emit(JSON.stringify({ x: "x".repeat(300000) }) + "\\n"); process.exit(0)' | (sleep 0.3; cat)`], { maxBuffer: 1 << 26 }).toString();
  assert.equal(JSON.parse(emitOut).x.length, 300000, 'item 8: emit() delivers 300 KB whole before exit');
  console.log('SID-191 item 8: 3 commands over 64 KiB deny with whole JSON; emit() delivers 300 KB');
}

// SID-191 re-review (5726655377 on f8c5388): literal-only guarded contexts. Every repro of items 1-7 must deny.
const sid191Rev2 = ["git -c core.hooks{P..P}ath=/tmp/h commit -m x", "git -c core.hooksP?th=h commit -m x", "git -c include.p{a..a}th=/tmp/c status", "git -ccore.hooksP?th=h commit -m x", "git --config-env=core.hooksP?th=V commit -m x", "git -c core.hooks[P]ath=h commit -m x", "gh pr {m..m..1}erge 1", "git reset --{h..h..1}ard HEAD~1", "{g..g}it reset --hard HEAD~1", "g{h..h} pr merge 1", "{n..n}pm publish", "{{gh,},} pr merge 1", "gh pr m[[:alpha:]]rge 1", "git reset --ha[[:lower:]]d HEAD~1", "git push origin ma[[:alpha:]]n", "touch feat:main; git push origin feat:ma?n", "git push origin refs/heads/ma?n", "git push origin feat:refs/heads/m?in", "git clean -[f]dx", "/usr/local/bin/g? pr merge 1", "shopt -s extglob\ngh pr @(merge) 1", "shopt -s nocaseglob\ngh pr MERG? 1", "bash -c 'p(){ \"$@\"; }; p gh pr merge 1'", "bash -c 'shift; \"$@\"' _ x gh pr merge 1", "bash -c '\"${@:2}\"' _ x gh pr merge 1", "bash -c 'IFS=,; $1' _ gh,pr,merge,1", "p(){ \"${@}\"; }; p gh pr merge 1", "p(){ \"${@:1}\"; }; p gh pr merge 1", "set -- gh pr merge 1; \"$@\"", "X=gh,pr,merge,1; IFS=,; $X", "read -r X <<<\"gh pr merge 1\"; $X", "printf -v X 'gh pr merge 1'; $X", "mapfile -t X < <(echo gh); \"${X[@]}\" pr merge 1", "shopt -s expand_aliases\nalias p=\"gh pr merge\"\np 1", "npm --silent ${X:-publish}"];
for (const c of sid191Rev2) for (const b of ['feat/x', 'main']) assert.ok(guardDenies(c, b), `SID-191 re-review must deny on ${b}: ${JSON.stringify(c)}`);
for (const c of sid191Rev2.filter((_, k) => k % 5 === 0)) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-191 re-review must deny through the hook: ${JSON.stringify(c)}`);
// Accepted over-denials: a glob or brace in a guarded command, positional parameters in a -c script. The message says to spell it out.
const sid191LiteralCollateral = ['git add *', 'git add *.mjs', 'git add src/*.mjs docs/*.md', 'cargo test -- *', 'git add src/{a,b}.ts', 'npm test -- *', "sh -c 'echo \"$1\"' _ hi", '$EDITOR notes.md', '$PYTHON tool/x.py', '"$SHELL" -lc true', '$CMD status', '$CMD', 'git push origin feat/*', 'git log | while read l; do echo "$l"; done', '"$HOME/bin/tool" status', 'git checkout -b feat/$NAME'];
for (const c of sid191LiteralCollateral) assert.ok(guardDenies(c), `SID-191 literal-only collateral (documented): ${c}`);
for (const c of sid191LiteralCollateral.slice(0, 6)) assert.match(newRules.segmentReason(c, sid191Cfg, 'feat/x')?.why ?? '', /spell the paths or words out/, `SID-191: the glob/brace deny says to spell it out: ${c}`);
const sid191LiteralAllow = ['git log -g HEAD@{1}', "git log --format='{%H}'", 'git log --format={%H}', 'echo {a,b} *', 'ls src/*.ts | wc -l', 'for f in *.md; do git add "$f"; done', '[ -f x ] && git status', '[[ -n "$X" ]] && git status', 'git status # *x* {a,b}', 'eval "$(ssh-agent -s)"',
  'git commit -m "$(cat <<\'EOF\'\n* bullet {a,b} [x]\nEOF\n)"', 'git commit -m "fix: *.md and {a,b}"', 'f(){ echo "$@"; }; f a b', 'X=1 git status', 'env -u X git status', 'timeout 5 git fetch origin', 'cd "$(git rev-parse --show-toplevel)" && git status', 'read -r X < f; echo "$X"', 'shopt -s nullglob; ls *.md'];
for (const c of sid191LiteralAllow) assert.ok(!guardDenies(c), `SID-191 literal-only must allow: ${c} (${newRules.lineReason(c) ?? newRules.segmentReason(c, sid191Cfg, 'feat/x')?.why})`);
// Generated: each SPLIT_BODIES word built by a step sequence, a POSIX class, a nested brace, and each body after a word-reading line or as a positional -c script.
const rev2Variants = [];
for (const body of SPLIT_BODIES) {
  const ws = body.split(' ');
  ws.forEach((w, k) => {
    if (!/^[A-Za-z-]/.test(w) || w.length < 2) return;
    const at = (x) => [...ws.slice(0, k), x, ...ws.slice(k + 1)].join(' ');
    const ch = w[1];
    rev2Variants.push(at(`${w[0]}{${ch}..${ch}..1}${w.slice(2)}`), at(`${w[0]}{{${ch},},}${w.slice(2)}`));
    if (/[a-z]/.test(ch)) rev2Variants.push(at(`${w[0]}[[:lower:]]${w.slice(2)}`), at(`${w[0]}[[:alpha:]]${w.slice(2)}`));
    if (/[A-Z]/.test(ch)) rev2Variants.push(at(`${w[0]}[[:upper:]]${w.slice(2)}`));
  });
  for (const pre of ['shopt -s extglob\n', 'shopt -s nocaseglob; ', 'IFS=,; ', 'set -- x; ', 'read -r Y < /dev/null; ', 'printf -v Y x; ', 'mapfile -t Y < /dev/null; ', 'alias q=true; ', 'eval true; ']) rev2Variants.push(pre + body);
  rev2Variants.push(`bash -c 'shift; "$@"' _ x ${body}`, `bash -c '"\${@:2}"' _ x ${body}`, `sh -c '$*' _ ${body}`, `bash -c 'p(){ "$@"; }; p ${body.replace(/'/g, '')}'`, `p(){ "\${@}"; }; p ${body}`, `set -- ${body}; "$@"`);
}
for (const c of rev2Variants) for (const b of ['feat/x', 'main']) assert.ok(guardDenies(c, b), `SID-191 re-review variant must deny on ${b}: ${JSON.stringify(c)}`);
// each literal-only and reread rule on its own (the line-level layers above can hide one of them)
const litDeny = ['FOO=1 git add src/x?.ts', 'nice -n5 git add src/x?.ts', 'env -u X git add src/{a,b}.ts', '"`printf gh`" pr merge 1', 'bash -c \'git add src/x?.ts\''];
for (const c of litDeny) assert.ok(newRules.literalReason(c) || newRules.segmentReason(c, sid191Cfg, 'feat/x')?.why?.includes('spell the paths'), `literal-only must deny: ${JSON.stringify(c)}`);
for (const c of ['FOO=1 git add src/x?.ts', 'nice -n5 git add src/x?.ts', '"`printf gh`" pr merge 1']) assert.ok(newRules.literalReason(c), `literalReason must deny: ${JSON.stringify(c)}`);
assert.ok(/spell the paths/.test(newRules.segmentReason("bash -c 'git add src/x?.ts'", sid191Cfg, 'feat/x')?.why ?? ''), 'a bash -c payload gets the literal-only argument rule');
for (const c of ["cat <<'E'\n$X arg\nE", 'cat <<E\n$X arg\nE', "git commit -F - <<'E'\n$X *\nE"]) assert.equal(newRules.literalReason(c), null, `a heredoc body is not a command: ${JSON.stringify(c)}`);
for (const c of ['IFS=: git status', 'eval x; git status', 'set -- a b; git status', 'set -o noglob; git status', 'printf -v X gh; git status', 'declare -n r=x; git status', 'read -r x; git status', 'mapfile a; git status'])
  assert.ok(newRules.rereadReason(c), `rereadReason must deny: ${JSON.stringify(c)}`);
for (const c of ['IFS=: ls', 'eval "$(fnm env)"', 'set -e; ls', 'printf "%s" x', 'read -r x']) assert.equal(newRules.rereadReason(c), null, `rereadReason leaves lines without a guarded word: ${JSON.stringify(c)}`);
assert.ok(newRules.segmentReason("bash -c 'shift; echo hi' _ x", sid191Cfg, 'feat/x')?.why?.includes('positional'), 'shift in a bash -c payload is positional use');
console.log(`SID-191 re-review: ${sid191Rev2.length} repros must-deny, ${sid191LiteralCollateral.length} documented collateral, ${sid191LiteralAllow.length} must-allow, ${rev2Variants.length} generated variants x 2 branches denied`);

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
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin HEAD'))), /^harness guard: you are on protected branch main; create a feature branch and push that \(HEAD\/@ here is main: git switch -c <name>/);
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin +HEAD'))), /\+ refspec/);
for (const c of ['git push origin 2>&1', 'git push origin > /dev/null', 'git push origin >/dev/null 2>&1', 'git push origin 2>/dev/null', 'git push -o ci.skip origin', 'git push --push-option ci.skip origin', 'git push --repo origin', 'git push --receive-pack git-receive-pack origin', 'git push --exec x origin'])
  assert.match(reasonOf(run('pre-bash.mjs', bash(c))), /protected branch main; create a feature branch and push that/, `SID-80 redirection/option arg: ${c}`);
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin HEAD > /dev/null'))), /feature branch/, 'HEAD with redirection still denied');
for (const c of ['git push 2>&1 origin', 'git push >/dev/null origin', 'git push > /dev/null origin', 'git push origin HEAD>/dev/null', '2>&1 git push origin', 'git push origin 2>&1 & git status'])
  assert.ok(denied('pre-bash.mjs', bash(c)), `SID-80 must deny on main: ${c}`);
sh(repo, 'git checkout -q --detach');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin HEAD'))), /name the branch/, 'detached HEAD: the branch is unknown, so a HEAD push fails closed (SID-65)');
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
  String.raw`git push --re\ceive-p='true; git branch -D main' origin feat/x`, `git fetch --u$(echo)pl='true; git reset --hard' origin`, "git fetch --u`echo`pl='true; git reset --hard' origin", "git fetch --u${X}pl='true; git reset --hard' origin", "git fetch -$X-upl='true; git reset --hard' origin",
  "git push --e='true; git reset --hard; git-receive-pack' origin feat/x", "git push --e 'true; git reset --hard; git-receive-pack' origin feat/x",
  "git push --{e,e}='true; git reset --hard; git-receive-pack' origin feat/x", "git push -{-,-}e='true; git reset --hard; git-receive-pack' origin feat/x", "git fetch --u{p,p}l='true; git reset --hard; git-upload-pack' origin", "git push {--e,--e}='true; git reset --hard; git-receive-pack' origin feat/x", "git push --[e]='true; git reset --hard; git-receive-pack' origin feat/x",
  String.raw`printf '[core]\nfsmonitor = "[ -e MARK ] || { touch MARK; git reset --hard; }; false"\n' | sort -o .git/config`, `git log -1 --output=.git/config --format='[core]%nrepositoryformatversion = 0%nfsmonitor = "[ -e MARK ] || { touch MARK; git reset --hard; }; false"'`,
  String.raw`printf 'touch MARK; git reset --hard\n' | uniq - f.sh`, "git log -1 --output=f.sh --format='true; git reset --hard'", String.raw`printf 'touch MARK; git reset --hard\n' | sort -o f.sh`, String.raw`printf 'touch MARK; git reset --hard\n' | uniq - .git/config`,
  String.raw`printf 'touch MARK; git reset --hard\n' | sort --outp=f.sh`, String.raw`printf 'touch MARK; git reset --hard\n' | sort -uo f.sh`, "sort --co='x; git reset --hard' f",
  // SID-107: text fed to a shell from stdin or a process substitution
  "echo 'git reset --hard' | sh", "echo 'git reset --hard' | bash -s", 'echo git reset --hard | sh', String.raw`printf 'git reset --hard\n' | sh`, "echo 'git reset --hard' | tee >(sh)", "echo 'git reset --hard' > >(sh)", "sh <(echo 'git reset --hard')",
  "echo 'git reset --hard' | xargs -I{} sh -c {}", "echo 'git reset --hard' | xargs -I % bash -c %", "echo 'git reset --hard' | xargs sh -c", "echo 'git push -f origin main' | sh", String.raw`printf 'gh pr merge 1\n' | bash`,
  // SID-107 follow-up: source / . on a process substitution or stdin, xargs replace-string or positional use inside sh -c, a script built from a command substitution
  "source <(echo 'git reset --hard')", ". <(echo 'git reset --hard')", "echo 'git reset --hard' | source /dev/stdin", "echo 'git reset --hard' | . /dev/stdin",
  "echo 'git reset --hard' | xargs -I{} sh -c 'eval {}'", `echo 'git reset --hard' | xargs sh -c 'eval "$@"' _`, `echo 'git reset --hard' | xargs sh -c 'eval "$1"' _`, "echo 'git reset --hard' | xargs sh -c 'eval $0'",
  `sh -c "$(echo 'git reset --hard')"`, "bash -c \"`printf 'git reset --hard'`\"", `eval "$(echo 'git reset --hard')"`, "eval `echo git reset --hard`",
  // SID-108: an unquoted glob that can expand to an option-named file (touch -- '--e=git reset --hard HEAD #')
  'git push [-]-e* origin feat/x', 'git push ?-e* origin feat/x', 'git push * origin feat/x', 'git push [!a]* origin feat/x', 'git push [^x]* origin feat/x', 'git fetch [-]-u* origin', 'git clone [-]-u* x y', 'git ls-remote [-]-u* origin', 'git pull [-]-u* origin', 'git archive [-]-r* HEAD', 'git submodule update [-]-u* x'];
const classAAllow = [String.raw`echo $'it\'s ok'`, String.raw`echo $'a\nb'`];
for (const c of [...classA, ...classB, ...classC, ...classD]) assert.ok(denied('pre-bash.mjs', bash(c)), `SID-79 review must deny: ${JSON.stringify(c)}`);
for (const c of [...classAAllow, ...classBAllow, ...classCAllow]) assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-79 review must allow: ${JSON.stringify(c)} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);
// SID-79 review round 6: a heredoc body no shell reads keeps main's handling of leading keywords; the same body fed to a shell is still checked.
for (const kw of ['then', 'if', 'do', 'while', '!']) {
  const ok = L('cat > notes.md <<EOF', `${kw} git push -f is never allowed.`, 'EOF');
  assert.ok(!denied('pre-bash.mjs', bash(ok)), `SID-79 round 6 must allow: ${JSON.stringify(ok)} (${reasonOf(run('pre-bash.mjs', bash(ok)))})`);
  const bad = L('bash <<EOF', `${kw} git push -f origin main`, 'EOF');
  assert.ok(denied('pre-bash.mjs', bash(bad)), `SID-79 round 6 must deny: ${JSON.stringify(bad)}`);
}
{
  const ok = L('cat > notes.md <<EOF', 'then git push -f is never allowed.', 'EOF');
  assert.ok(!denied('pre-bash.mjs', bash(ok)), `SID-79 round 6 must allow: ${JSON.stringify(ok)} (${reasonOf(run('pre-bash.mjs', bash(ok)))})`);
  const bad = L('bash <<EOF', 'then git push -f is never allowed.', 'EOF');
  assert.ok(denied('pre-bash.mjs', bash(bad)), `SID-79 round 6 must deny: ${JSON.stringify(bad)}`);
}
// SID-79 review round 7: plain sort/uniq/git output options and sort option clusters stay allowed.
for (const ok of ['sort -o out.txt in.txt', 'uniq in.txt out.txt', 'git log -1 --output=/tmp/log.txt', 'git diff --output=patch.diff', 'sort -k2 -t, data.csv', "git log --oneline -- '*.mjs'"]) assert.ok(!denied('pre-bash.mjs', bash(ok)), `SID-79 round 7 must allow: ${JSON.stringify(ok)} (${reasonOf(run('pre-bash.mjs', bash(ok)))})`);

// Writes into a git dir make quoted text code (git runs core.pager, aliases, hooks): no quote trust, and the write itself is denied.
const CFG = /writing a git config file directly/, HOOK = /writing into a hooks directory/, INFO = /write into \.git\/info or \.git\/modules/, PAGER = String.raw`printf '[core]\n\tpager = true; git reset --hard\n'`;
const gitWriteDeny = [[`${PAGER} >> .git/config && git log`, CFG], [String.raw`printf '[core]\n\tpager = "true; git reset --hard"\n' >> .git/config && git log`, CFG],[`printf 'true; git reset --hard\\n' > .git/hooks/pre-commit && git commit -m x`, HOOK], [`printf 'x' > .git/hooks/pre-commit`, HOOK], [`echo '[alias] x = !true' >> .git/config`, CFG],
  [`${PAGER} | tee -a .git/config && git log`, CFG], [`printf 'x' | sudo tee .git/hooks/pre-push`, HOOK], ['cp /tmp/evil .git/hooks/pre-commit', HOOK], ['cp /tmp/evil .git/hooks/', HOOK], ['install -m 755 /tmp/evil .git/hooks/post-checkout', HOOK],
  ['ln -s ../../evil.sh .git/hooks/pre-commit', HOOK], ['mv cfg .git/config', CFG], ['cp -t .git/hooks /tmp/evil', HOOK], ["sed -i 's/less/true; git reset --hard/' .git/config && git log", CFG], ["sed -i.bak '$a pager = x' .git/config", CFG],
  ["perl -pi -e 's/a/b/' .git/config", CFG], ['printf x > ".git/config"', CFG], ['printf x >.git/config', CFG], ['printf x 1>> .git/config', CFG], ['dd of=.git/config if=/tmp/x', CFG], ["printf 'x' > .git/info/attributes && git status", INFO],
  [`${PAGER} >> .git/modules/sub/config && git -C sub log`, INFO], ["printf 'x' > .git/modules/sub/hooks/pre-commit", HOOK], ["printf 'x' > ../origin.git/hooks/pre-receive && git push origin feat/x", HOOK], [`cd .git && ${PAGER} >> config && git log`, CFG],
  ['cd .git/hooks && cp /tmp/evil pre-commit', HOOK], ['printf x > "$GIT_DIR/hooks/pre-commit"', HOOK], ['printf x > "$(git rev-parse --git-dir)/config"', CFG], ['GIT_DIR=/tmp/g.d git log > /dev/null; printf x > /tmp/g.d/config', CFG],
  ['git --git-dir=/tmp/g.d status; printf x >> /tmp/g.d/hooks/pre-commit', HOOK],
  [`${PAGER} >> $HOME/.gitconfig && git log`, CFG], [`${PAGER} >> \${HOME}/.gitconfig`, CFG], [`${PAGER} >> ~/.config/git/config && git log`, CFG], [`${PAGER} >> $HOME/.config/git/config`, CFG], [`${PAGER} >> $XDG_CONFIG_HOME/git/config`, CFG],
  [`${PAGER} >> \${XDG_CONFIG_HOME}/git/config`, CFG], [`${PAGER} | sudo tee -a /etc/gitconfig`, CFG], [`${PAGER} >> /home/u/.gitconfig`, CFG], [`${PAGER} >> ~/.gitconfig`, CFG],
  [String.raw`echo "$(printf '[core]\n\tpager = true; git reset --hard\n' >> .git/config)" && git log`, CFG],
  [String.raw`printf 'x\n' | sort -o .git/config`, CFG], [String.raw`printf 'x\n' | uniq - .git/config`, CFG], ['git log -1 --output=.git/config --format=x', CFG], ['git diff --output .git/config', CFG], ['sort -uo .git/config f', CFG], [String.raw`printf 'x\n' | sort -o .git/hooks/pre-commit`, HOOK]];
const gitWriteAllow = ['cat .git/config', 'ls .git/hooks', 'ls -la .git/hooks/', 'git config --get core.pager', 'grep x .git/config', 'sed -n 1p .git/config', 'cp .git/config /tmp/sflow-bak', 'cat .git/config > /tmp/sflow-x', "printf 'x' > .git/info/exclude", "printf 'notes' > notes.md && git commit -m x", 'echo hi > config && git status'];
for (const [c, why] of gitWriteDeny) { assert.ok(denied('pre-bash.mjs', bash(c)), `git write must deny: ${c}`); assert.match(reasonOf(run('pre-bash.mjs', bash(c))), why, `git write reason: ${c}`); }
for (const c of gitWriteAllow) assert.ok(!denied('pre-bash.mjs', bash(c)), `git write must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);
for (const c of gitWriteAllow.filter((x) => !/\.git\/info/.test(x))) assert.deepEqual(newGitWrites(c), [], `gitWrites reads are not writes: ${c}`);
assert.deepEqual(newGitWrites('cd .git/hooks && cp /tmp/evil pre-commit'), [{ path: '.git/hooks/pre-commit', kind: 'hooks' }]);
assert.deepEqual(newGitWrites('echo "a > .git/config"'), [], 'a quoted > is text');
for (const c of ['cat ~/.gitconfig', 'git config --global --get user.name', 'echo "a > ~/.gitconfig"']) assert.deepEqual(newGitWrites(c), [], `global config reads are not writes: ${c}`);
for (const c of ["printf 'ok' > notes.md", 'echo x | tee a.txt', 'cp a b', 'mv a b', 'ln -s a b', 'install a b', 'dd of=f if=g', 'truncate -s 0 f', "sed -i 's/a/b/' f", "perl -pi -e 's/a/b/' f", 'echo "$(echo x > f)"', 'echo `echo x > f`']) assert.ok(writesFile(c), `writesFile: ${c}`);
for (const c of ['echo "a; b"', 'echo x > /dev/null', 'echo x 2>&1', 'echo x >&2', 'echo x | tee', 'echo x | tee /dev/null', 'echo x > /dev/stderr', "cat <<'EOF'\nx\nEOF", 'cat f', 'sed -n 1p f', 'git log | grep x', 'cat ~/.gitconfig']) assert.ok(!writesFile(c), `writesFile false: ${c}`);

// SID-147 review (5725928282): config changes that turn off the git hooks outside Claude, or point their chaining somewhere an agent chose, are denied.
const HOOKS_CFG = /turns off the git hooks that run outside Claude|`git config --edit` can change any key|overriding core\.hooksPath disables the project hooks/; // a core.hooksPath key in any case hits envReason first
for (const c of ['git config --remove-section core', 'git config --rename-section core x', 'git config --rename-section x core', 'git config remove-section core', 'git config rename-section core x',
  'git config --local --remove-section CORE', 'git config -f .git/config --remove-section core', 'git -C . config --remove-section core', 'git -c user.name=x config --remove-section "core"',
  'git config --unset-all core.hookspath', 'git config core.HOOKSPATH /tmp/x', 'git config unset core.HooksPath', 'git config -e', 'git config --edit', 'git config --global --edit', 'git config edit',
  'git config sflow.previousHooksPath /tmp/evil', 'git config --add sflow.x y', 'git config set sflow.previousHooksPath /tmp/evil', 'git config --unset sflow.previousHooksPath', 'git config --remove-section sflow',
  'git config --local --rename-section sflow x', 'true && git config SFLOW.previousHooksPath /tmp/evil'])
  assert.match(reasonOf(run('pre-bash.mjs', bash(c))), HOOKS_CFG, `SID-147 must deny: ${c} (got: ${reasonOf(run('pre-bash.mjs', bash(c))) || 'allowed'})`);
for (const c of ['git config --get sflow.previousHooksPath', 'git config --remove-section alias', 'git config --rename-section alias.x alias.y', 'git config user.name x', 'git config --list'])
  assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-147 must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);
// SID-147 review (CTO, Nov 1): core.hooksPath overrides in any letter case. git matches config keys case-insensitively, so each of these ran a planted
// hook end to end before the `i` flag. Env var NAMES are case-sensitive (git ignores git_config_key_0), so lowercase names are not a bypass; they are
// denied anyway because the text still names the key. Reading core.hooksPath (`git config --get core.hookspath`) is denied too, as before for the
// camel-case spelling: over-broad, tracked on SID-161.
const HOOKS_OVR = /^harness guard: overriding core\.hooksPath disables the project hooks/;
for (const k of ['core.hooksPath', 'core.hookspath', 'CORE.HOOKSPATH', 'core.HooksPath', 'Core.hookSpath'])
  for (const c of [`git -c ${k}=/tmp/evil commit -m x`, `git -c "${k}=/tmp/evil" commit -m x`, `git -c '${k}'=/tmp/evil push origin feat`, `HP=/tmp/evil git --config-env=${k}=HP commit -m x`,
    `HP=/tmp/evil git --config-env ${k}=HP commit -m x`, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${k} GIT_CONFIG_VALUE_0=/tmp/evil git commit -m x`,
    `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${k} GIT_CONFIG_VALUE_0=/tmp/evil git commit -m x`, `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${k} GIT_CONFIG_VALUE_0=/tmp/evil; git commit -m x`,
    `GIT_CONFIG_PARAMETERS="'${k}'='/tmp/evil'" git commit -m x`, `env GIT_CONFIG_PARAMETERS="'${k}'='/tmp/evil'" git push origin feat`, `export GIT_CONFIG_PARAMETERS="'${k}'='/tmp/evil'" && git commit -m x`,
    `git_config_count=1 git_config_key_0=${k} git_config_value_0=/tmp/evil git commit -m x`, `git_config_parameters="'${k}'='/tmp/evil'" git commit -m x`])
    assert.match(reasonOf(run('pre-bash.mjs', bash(c))), HOOKS_OVR, `SID-147 must deny (any case): ${c} (got: ${reasonOf(run('pre-bash.mjs', bash(c))) || 'allowed'})`);
for (const c of ['git -c core.editor=vim commit -m x', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m x', 'git -c core.autocrlf=false status', 'git config --get core.editor'])
  assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-147 must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);
// SID-155: deleting, moving or un-executing git hooks (.git/hooks, a submodule's or linked worktree's, SID-147's .git/sflow-hooks, .husky) is denied; globs that could match fail closed. Reads and ordinary removals stay allowed.
const UNHOOK = /deleting or moving git hooks turns off the guards that run outside Claude/;
const unhookDeny = ['rm -rf .git/hooks', 'rm -f .git/hooks/pre-push', 'mv .git/hooks /tmp/x', 'rm -rf .git/sflow-hooks', 'rm .git/sflow-hooks/pre-push', 'rm -rf .husky', 'rm -rf .husky/', 'rm .husky/pre-commit',
  'mv .husky/pre-commit .husky/off', 'rm -rf .git/hoo*', 'rm -rf .git/*', 'rm -rf .gi?/hooks', 'rm -rf .git/[h]ooks', 'rm -rf .git/sflow-*', 'rm -rf .hu*', 'cd .git && rm -rf hooks', 'cd .git/hooks && rm pre-push', 'cd .husky; rm pre-commit',
  'rm -rf "$(git rev-parse --git-path hooks)"', 'rm -rf `git rev-parse --git-path hooks`', 'rm -rf "$(git rev-parse --git-common-dir)/hooks"', 'rm -rf "$GIT_DIR/hooks"', 'GIT_DIR=/r/.git rm -rf /r/.git/hooks',
  'rm -rf /workspace/repo/.git/hooks', 'rm -rf /workspace/repo/.git/worktrees/wt/hooks', 'rm -r .git/modules/sub/hooks', 'unlink .git/hooks/pre-commit', 'rmdir .git/hooks', 'shred -u .git/hooks/pre-push', 'rm -rf ./.git//hooks/',
  'find .git/hooks -delete', 'find .git/hooks -type f -exec rm {} +', 'find .husky -name pre-commit -delete', 'chmod -x .git/hooks/pre-push', 'chmod 644 .git/sflow-hooks/pre-commit', 'chmod -R a-x .husky', 'sudo rm -rf .git/hooks',
  'mv -t /tmp .git/hooks', 'mv --target-directory=/tmp .git/hooks/pre-push', 'true; rm -rf .git/hooks', 'echo "$(rm -rf .git/hooks)"', 'git status && rm -rf .git/hooks'];
const unhookAllow = ['rm -rf build/', 'rm hooks.txt', 'rm -rf hooks', 'rm -rf src/hooks', 'rm -rf node_modules', 'rm .gitignore', 'rm -rf .github/x', 'rm -rf *', 'ls .git/hooks', 'cat .git/hooks/pre-push', 'ls .husky',
  'cp .git/hooks/pre-push /tmp/sflow-x', 'find .git/hooks -name x', 'find . -name "*.pyc" -delete', 'chmod +x scripts/x.sh', 'mv a b', "echo 'rm -rf .git/hooks'"];
for (const c of unhookDeny) { const r = reasonOf(run('pre-bash.mjs', bash(c))); assert.match(r, UNHOOK, `SID-155 must deny: ${c} (got: ${r || 'allowed'})`); }
assert.ok(denied('pre-bash.mjs', bash('rm -rf .h*')), 'SID-155: .h* could match .husky and .harness.json; denied (the policy reason wins)');
for (const c of unhookAllow) assert.ok(!denied('pre-bash.mjs', bash(c)), `SID-155 must allow: ${c} (${reasonOf(run('pre-bash.mjs', bash(c)))})`);
// CTO review of #23 (5725928139): a wrapper line with a trailing rm-family word used to skip the GIT_CMDS write scan, allowing writes main denies.
// The 11 rows from the review, then every wrapper x write x trailing rm word. All go through bash(), so the regression check below also proves main denies them.
const wrapRm = ['env tee .git/hooks/pre-commit rm', 'xargs tee .git/hooks/pre-commit rm', 'command tee .git/hooks/pre-commit rm', 'nohup tee .git/hooks/post-checkout shred',
  'nohup sed -i s/x/y/ .git/hooks/pre-commit unlink', 'env perl -pi -e s/a/b/ .git/hooks/pre-commit rm', 'time dd of=.git/hooks/pre-push rm', 'env tee .git/config rm',
  'sudo tee -a .git/config chmod', 'env sed -i s/a/b/ .git/config rmdir', 'env truncate -s0 .git/config unlink'];
for (const w of ['env', 'sudo', 'nohup', 'time', 'xargs', 'command']) for (const wr of ['tee .git/hooks/pre-commit', 'tee -a .git/config', 'sed -i s/a/b/ .git/hooks/pre-push', 'dd of=.git/config', 'truncate -s0 .git/hooks/pre-commit'])
  for (const r of ['rm', 'unlink', 'rmdir', 'shred', 'find', 'chmod']) wrapRm.push(`${w} ${wr} ${r}`);
for (const c of wrapRm) assert.ok(denied('pre-bash.mjs', bash(c)), `#23 review: wrapper + write + trailing rm word must stay denied: ${c}`);
// Overwriting or emptying a stub disables SID-147 as well as deleting it: writes into .git/sflow-hooks and a linked worktree's hooks are git-dir hook writes.
for (const c of ["printf 'exit 0\\n' > .git/sflow-hooks/pre-push", 'cp /dev/null .git/sflow-hooks/pre-push', 'tee .git/sflow-hooks/pre-commit', 'echo x >> .git/sflow-hooks/pre-commit',
  'echo x > .git/worktrees/wt/hooks/pre-push', 'cp evil /r/.git/sflow-hooks/pre-push', 'ln -sf /tmp/x .git/sflow-hooks/pre-push', 'sed -i s/node/true/ .git/sflow-hooks/pre-push'])
  assert.ok(denied('pre-bash.mjs', bash(c)), `#23 review: writing a stub must be denied: ${c}`);
assert.deepEqual(newGitWrites('cd .git && rm -rf hooks'), [{ path: '.git/hooks', kind: 'unhook' }]);
assert.deepEqual(newGitWrites('mv .git/hooks /tmp/x'), [{ path: '.git/hooks', kind: 'unhook' }], 'mv: the source goes, /tmp/x is no git write');
{ // real git: a linked worktree's hooks path, as git itself reports it, is denied from inside the worktree; nothing was run, the hooks dir is still there.
  const wt = `${repo}.wt155`;
  sh(repo, `git worktree add -q -b feat/wt155 "${wt}"`);
  const hp = sh(wt, 'git rev-parse --path-format=absolute --git-path hooks');
  for (const c of [`rm -rf ${hp}`, `rm -f ${hp}/pre-push`, `mv ${hp} /tmp/x`, 'rm -rf "$(git rev-parse --git-path hooks)"']) assert.match(reasonOf(run('pre-bash.mjs', bash(c, wt))), UNHOOK, `SID-155 linked worktree: ${c}`);
  assert.ok(existsSync(hp), 'the guard only decides; the hooks dir is untouched');
  sh(repo, `git worktree remove --force "${wt}" && git branch -q -D feat/wt155`);
}

// Gate: origin's policy wins over a working-tree edit; commit-and-push chains and dirty trees are refused; pass records HEAD and is skipped next time.
writeFileSync(join(repo, '.harness.json'), JSON.stringify({ gate: [], allowMerge: true }));
assert.ok(denied('pre-bash.mjs', bash('gh pr merge 1')), 'working-tree policy edit must not take effect');
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin feat/x'))), /uncommitted/);
sh(repo, 'git checkout -q -- .harness.json');
assert.match(reasonOf(run('pre-bash.mjs', bash('git add -A && git commit -m x && git push origin feat/x'))), /commit in one command/);
sh(repo, 'echo b > b && git add b && git commit -qm b');
assert.equal(run('pre-bash.mjs', bash('git push origin feat/x')), null, 'passing gate allows');
const gitdir = sh(repo, 'git rev-parse --absolute-git-dir');
assert.ok(existsSync(join(gitdir, GATE_RECORD_DIR, sh(repo, 'git rev-parse HEAD'))), 'gate records HEAD');
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
sh(repo, `echo "key = ${TOKEN}" > s.txt && git add s.txt && git commit -qm s`);
assert.match(reasonOf(run('pre-bash.mjs', bash('git push origin feat/x'))), /AWS key/);
// SID-213: the scan now reads every commit in the range, so a later `git rm` no longer clears this branch. Later steps keep pushing feat/x, so the harness's own git drops the commit instead.
sh(repo, 'git reset -q --hard HEAD~1');

// Fail closed: a malformed policy on origin denies instead of crashing open.
sh(repo, "git checkout -q main && printf '{bad' > .harness.json && git commit -qam bad && git push -q origin main && git checkout -q feat/x");
assert.match(reasonOf(run('pre-bash.mjs', bash('git push --force origin feat/x'))), /failing closed|force push/);
assert.match(reasonOf(run('pre-bash.mjs', bash('git status'))), /failing closed/);
setPolicy({ gate: ['test -f a'] });

// Linked worktree: .git is a file; gate and stop still work.
const wt = trackScratch(join(repo, '..', 'wt-' + Date.now()));
sh(repo, `git worktree add -q -b feat/wt "${wt}" main && cd "${wt}" && echo w > w && git add w && git commit -qm w`);
assert.equal(run('pre-bash.mjs', bash('git push origin feat/wt', wt)), null, 'gate passes in a worktree');
assert.ok(existsSync(join(sh(wt, 'git rev-parse --absolute-git-dir'), GATE_RECORD_DIR, sh(wt, 'git rev-parse HEAD'))), 'gate records in the worktree git dir');

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
const plain = makeScratch('plain-');
sh(plain, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init && echo b > b');
assert.equal(run('stop.mjs', { cwd: plain, stop_hook_active: false }), null, 'repo without .harness.json is left alone');
assert.equal(run('pre-bash.mjs', bash('git push --force', plain))?.hookSpecificOutput?.permissionDecision, 'deny', 'guard still applies without a policy file');

// Policy hook.
for (const f of ['.harness.json', '.claude/settings.json'])
  assert.ok(denied('policy.mjs', { tool_name: 'Edit', tool_input: { file_path: join(repo, f) }, cwd: repo }), `policy denies ${f}`);
assert.ok(!denied('policy.mjs', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/x.ts') }, cwd: repo }));

// SID-162: the file tools can't write git hook files either (the shell guard's `hooks` rule). By name, resolved (`..`, `//`, symlinked parents),
// and against the repo's real hooks dirs: a separate git dir, a linked worktree, a configured core.hooksPath.
const HOOK_FILE = /^harness: writing into a hooks directory installs code git runs automatically/;
const fileTool = (tool, file_path, cwd) => reasonOf(run('policy.mjs', { tool_name: tool, tool_input: { file_path, content: 'x' }, cwd }));
const hookRepo = realpathSync(makeScratch('harness-hookfile-'));
sh(hookRepo, 'git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add a && git commit -qm init && mkdir -p hk src/hooks hooks/harness docs');
sh(hookRepo, 'git worktree add -q -b wt wt');
symlinkSync(join(hookRepo, '.git', 'hooks'), join(hookRepo, 'lnk'));
const sep = realpathSync(makeScratch('harness-hookfile-sep-'));
sh(sep, 'git init -q --separate-git-dir ../$(basename $PWD).gitdir w');
const sepGit = trackScratch(join(dirname(sep), `${basename(sep)}.gitdir`)); // resolved, not via sep/.., so cleanup still finds it after sep is gone
const hookDeny = [[join(hookRepo, '.git/hooks/pre-commit'), hookRepo], ['.git/hooks/pre-push', hookRepo], [join(hookRepo, '.git/sflow-hooks/pre-push'), hookRepo],
  [join(hookRepo, '.git/worktrees/wt/hooks/pre-push'), hookRepo], [join(hookRepo, '.git/modules/sub/hooks/post-checkout'), hookRepo], [join(hookRepo, 'src/../.git/hooks/pre-commit'), hookRepo],
  [join(hookRepo, '.git') + '//hooks/pre-commit', hookRepo], ['src/../.git/./hooks/x', hookRepo], [join(hookRepo, 'lnk/pre-commit'), hookRepo], [join(hookRepo, '.git/hooks'), hookRepo],
  [join(hookRepo, '.git/sflow-hooks/previous-hooks-path'), hookRepo], ['../.git/hooks/pre-commit', join(hookRepo, 'wt')], [join(sepGit, 'hooks/pre-commit'), join(sep, 'w')], [join(sepGit, 'sflow-hooks/pre-push'), join(sep, 'w')]];
for (const tool of ['Write', 'Edit', 'MultiEdit']) for (const [f, cwd] of hookDeny) assert.match(fileTool(tool, f, cwd), HOOK_FILE, `SID-162 must deny ${tool} ${f} (cwd ${cwd})`);
const hookAllow = ['src/hooks/useX.ts', 'hooks/harness/x.mjs', 'docs/.git-hooks.md', '.github/hooks/x.yml', '.githooks/pre-commit', 'hk/pre-commit', 'a', 'wt/a', '.gitignore'];
for (const f of hookAllow) assert.equal(fileTool('Write', join(hookRepo, f), hookRepo), '', `SID-162 must allow ${f}`);
assert.equal(fileTool('Write', join(sep, 'w', 'src/x.ts'), join(sep, 'w')), '', 'SID-162: ordinary file in a separate-git-dir repo');
sh(hookRepo, 'git config core.hooksPath hk'); // a configured hooks dir is protected too, relative to the work tree, from anywhere in the repo
for (const [f, cwd] of [[join(hookRepo, 'hk/pre-commit'), hookRepo], ['hk/pre-push', hookRepo], ['../hk/x', join(hookRepo, 'src')], [join(hookRepo, 'hk/new/x'), hookRepo]])
  assert.match(fileTool('Edit', f, cwd), HOOK_FILE, `SID-162 core.hooksPath must deny ${f}`);
assert.equal(fileTool('Edit', join(hookRepo, 'src/hooks/useX.ts'), hookRepo), '', 'SID-162: core.hooksPath protects only that dir');
sh(hookRepo, `git config core.hooksPath ${join(hookRepo, 'docs')}`);
assert.match(fileTool('Write', join(hookRepo, 'docs/pre-push'), hookRepo), HOOK_FILE, 'SID-162: absolute core.hooksPath');
sh(hookRepo, 'git config --unset core.hooksPath');
assert.equal(fileTool('Write', join(hookRepo, 'hk/pre-commit'), hookRepo), '', 'SID-162: unset core.hooksPath, hk is an ordinary dir again');
assert.equal(fileTool('Write', join(tmpdir(), 'not-a-repo-file.txt'), tmpdir()), '', 'SID-162: outside any repo nothing changes');

// SID-162 review: dangling symlinks, hardlinks, global/system core.hooksPath, git config and .git/info files, NotebookEdit, fail closed.
const GIT_FILE = /^harness: writing a git config or \.git\/info file changes what git runs/;
const notebook = (notebook_path, cwd) => reasonOf(run('policy.mjs', { tool_name: 'NotebookEdit', tool_input: { notebook_path, new_source: 'x' }, cwd }));
writeFileSync(join(hookRepo, '.git/hooks/pre-commit'), '#!/bin/sh\n'); mkdirSync(join(hookRepo, '.git/sflow-hooks'), { recursive: true }); writeFileSync(join(hookRepo, '.git/sflow-hooks/pre-push'), '#!/bin/sh\n');
mkdirSync(join(sepGit, 'hooks'), { recursive: true }); writeFileSync(join(sepGit, 'hooks/pre-commit'), '#!/bin/sh\n');
symlinkSync('.git/hooks/post-commit', join(hookRepo, 'pc')); // dangling: the hook does not exist yet, a Write creates it
symlinkSync('pc', join(hookRepo, 'pc2')); // a chain of links
symlinkSync(join(sepGit, 'hooks', 'post-merge'), join(sep, 'w', 'pm')); // dangling into a hooks dir whose path has no .git/hooks in it
symlinkSync(join(hookRepo, 'nowhere', 'deeper'), join(hookRepo, 'dl')); // dangling, ordinary target
linkSync(join(hookRepo, '.git/hooks/pre-commit'), join(hookRepo, 'hl')); linkSync(join(hookRepo, '.git/sflow-hooks/pre-push'), join(hookRepo, 'hl2'));
linkSync(join(sepGit, 'hooks/pre-commit'), join(sep, 'w', 'hl3')); linkSync(join(sepGit, 'config'), join(sep, 'w', 'hlc'));
writeFileSync(join(hookRepo, 'docs/one'), 'x'); linkSync(join(hookRepo, 'docs/one'), join(hookRepo, 'docs/two')); // an ordinary hardlinked pair
for (const [f, cwd] of [['pc', hookRepo], [join(hookRepo, 'pc'), hookRepo], ['pc2', hookRepo], [join(sep, 'w', 'pm'), join(sep, 'w')], ['hl', hookRepo], ['hl2', hookRepo], ['hl3', join(sep, 'w')]])
  for (const tool of ['Write', 'Edit']) assert.match(fileTool(tool, f, cwd), HOOK_FILE, `SID-162 review must deny ${tool} ${f} (link)`);
assert.match(fileTool('Edit', join(sep, 'w', 'hlc'), join(sep, 'w')), HOOK_FILE, 'SID-162 review: hardlink to the git config');
for (const f of ['dl', 'docs/two', 'docs/one']) assert.equal(fileTool('Write', join(hookRepo, f), hookRepo), '', `SID-162 review must allow ${f}`);
const gitFileDeny = [[join(hookRepo, '.git/config'), hookRepo], ['.git/config.worktree', hookRepo], ['.git/CONFIG', hookRepo], [join(hookRepo, '.git/worktrees/wt/config.worktree'), hookRepo], ['.git/info/exclude', hookRepo],
  ['.git/info/attributes', hookRepo], ['.git/info/sparse-checkout', hookRepo], [join(hookRepo, '.git/modules/sub/config'), hookRepo], [join(sepGit, 'config'), join(sep, 'w')], [join(sepGit, 'config.worktree'), join(sep, 'w')], [join(sepGit, 'info/exclude'), join(sep, 'w')]];
for (const [f, cwd] of gitFileDeny) assert.match(fileTool('Write', f, cwd), GIT_FILE, `SID-162 review must deny config/info ${f}`);
for (const f of ['config/app.json', 'src/config.ts', '.gitattributes', 'info/readme.md', 'docs/gitconfig.md', 'wt/.git-info']) assert.equal(fileTool('Write', join(hookRepo, f), hookRepo), '', `SID-162 review must allow ${f}`);
assert.match(notebook(join(hookRepo, '.git/hooks/nb.ipynb'), hookRepo), HOOK_FILE, 'SID-162 review: NotebookEdit is checked (notebook_path)');
assert.equal(notebook(join(hookRepo, 'docs/nb.ipynb'), hookRepo), '', 'SID-162 review: NotebookEdit on an ordinary notebook');
assert.ok(JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse.some((h) => /NotebookEdit/.test(h.matcher) && h.hooks.some((x) => /policy\.mjs/.test(x.command))), 'SID-162 review: NotebookEdit in the policy matcher');
// Global and system core.hooksPath (absolute, ~/, relative) and the global config files, from any repo or none.
const ghome = realpathSync(makeScratch('harness-hookfile-home-')), other = realpathSync(makeScratch('harness-hookfile-other-'));
sh(other, 'git init -q -b main');
const runEnv = (hook, input, env) => spawnSync(process.execPath, [join(hooks, hook)], { input: typeof input === 'string' ? input : JSON.stringify(input), cwd: (typeof input === 'object' && input.cwd) || other, env: { ...process.env, ...env }, encoding: 'utf8' });
const verdict = (r) => { let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop() || 'null'); } catch {} return { status: r.status, why: j?.hookSpecificOutput?.permissionDecisionReason ?? (r.status === 2 ? r.stderr : '') }; };
const envTool = (file_path, cwd, env) => verdict(runEnv('policy.mjs', { tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd }, env));
const sysCfg = join(ghome, 'sysconfig');
writeFileSync(join(ghome, '.gitconfig'), `[core]\n\thooksPath = ${join(ghome, 'abs-hooks')}\n`);
writeFileSync(sysCfg, '[core]\n\thooksPath = ~/tilde-hooks\n');
const genv = { HOME: ghome, XDG_CONFIG_HOME: join(ghome, '.config'), GIT_CONFIG_GLOBAL: join(ghome, '.gitconfig'), GIT_CONFIG_SYSTEM: sysCfg, GIT_CONFIG_NOSYSTEM: '' };
for (const [f, cwd] of [[join(ghome, 'abs-hooks/pre-commit'), other], [join(ghome, 'abs-hooks/pre-commit'), tmpdir()], [join(ghome, 'tilde-hooks/pre-push'), other], [join(ghome, 'abs-hooks/pre-commit'), hookRepo]])
  assert.match(envTool(f, cwd, genv).why, HOOK_FILE, `SID-162 review: global/system core.hooksPath must deny ${f} (cwd ${cwd})`);
for (const f of [join(ghome, '.gitconfig'), join(ghome, '.config/git/config')]) assert.match(envTool(f, other, genv).why, GIT_FILE, `SID-162 review must deny ${f}`);
assert.match(envTool(join(ghome, 'alt.gitconfig'), other, { ...genv, GIT_CONFIG_GLOBAL: join(ghome, 'alt.gitconfig') }).why, GIT_FILE, 'SID-162 review: GIT_CONFIG_GLOBAL file');
writeFileSync(join(ghome, '.gitconfig'), '[core]\n\thooksPath = rel-hooks\n'); // relative: whichever repository runs its hooks
assert.match(envTool(join(other, 'rel-hooks/pre-commit'), other, genv).why, HOOK_FILE, 'SID-162 review: relative global core.hooksPath in the target repo');
assert.match(envTool(join(other, 'rel-hooks/pre-commit'), hookRepo, genv).why, HOOK_FILE, 'SID-162 review: relative global core.hooksPath, cwd in another repo');
assert.equal(envTool(join(ghome, 'notes.txt'), other, genv).why, '', 'SID-162 review: an ordinary file in HOME');
// Fail closed: every error path denies (JSON deny, or exit 2 with the reason on stderr), and outside a repository a normal write still passes.
const FAIL = /harness hook error \(failing closed\)/;
const noGit = realpathSync(makeScratch('harness-hookfile-nogit-'));
assert.match(envTool(join(hookRepo, 'docs/x.md'), hookRepo, { PATH: noGit }).why, FAIL, 'SID-162 review: missing git binary denies');
assert.match(envTool(join(tmpdir(), 'plain.txt'), tmpdir(), { PATH: noGit }).why, FAIL, 'SID-162 review: missing git binary denies outside a repo too');
assert.match(envTool(join(hookRepo, 'docs/x.md'), hookRepo, { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }).why, FAIL, 'SID-162 review: a safe.directory refusal denies'); // empty global, no system config: a runner's safe.directory=* can't lift the refusal
// A git (older or patched) whose safe.directory refusal also says "not a git repository" must still fail closed, not read as "no repository".
const fakeGit = realpathSync(makeScratch('harness-hookfile-fakegit-'));
writeFileSync(join(fakeGit, 'git'), "#!/bin/sh\necho \"fatal: not a git repository (or any parent): unsafe repository; add it to safe.directory\" >&2\nexit 128\n"); chmodSync(join(fakeGit, 'git'), 0o755);
assert.match(envTool(join(hookRepo, 'docs/x.md'), hookRepo, { PATH: `${fakeGit}:${process.env.PATH}` }).why, FAIL, 'SID-162 review: a refusal worded as "not a git repository ... safe.directory" denies');
const broken = realpathSync(makeScratch('harness-hookfile-broken-'));
sh(broken, 'git init -q -b main && printf "[core\\n\\tbad = = =\\n" >> .git/config');
assert.match(envTool(join(broken, 'x.md'), broken, {}).why, FAIL, 'SID-162 review: an unparsable git config denies');
const unread = realpathSync(makeScratch('harness-hookfile-unread-'));
sh(unread, 'git init -q -b main'); chmodSync(join(unread, '.git/config'), 0o000);
try { assert.match(envTool(join(unread, 'x.md'), unread, {}).why, FAIL, 'SID-162 review: an unreadable git config denies'); } finally { chmodSync(join(unread, '.git/config'), 0o644); }
assert.match(verdict(runEnv('policy.mjs', 'not json', {})).why, FAIL, 'SID-162 review: an unreadable event denies');
assert.match(verdict(runEnv('policy.mjs', '', {})).why, FAIL, 'SID-162 review: an empty event denies');
const nul = verdict(runEnv('policy.mjs', { tool_name: 'Write', tool_input: { file_path: `${hookRepo}/a\u0000b` }, cwd: hookRepo }, {}));
assert.match(nul.why, FAIL, 'SID-162 review: an exception inside the check denies');
for (const r of [runEnv('policy.mjs', 'not json', {}), runEnv('policy.mjs', { tool_name: 'Write', tool_input: { file_path: `${hookRepo}/a\u0000b` }, cwd: hookRepo }, {})]) assert.equal(r.status, 2, 'SID-162 review: fail-closed exits 2 (blocking)');
assert.equal(envTool(join(tmpdir(), 'plain.txt'), tmpdir(), {}).why, '', 'SID-162 review: outside a repository a normal Write is allowed');
assert.equal(envTool(join(tmpdir(), 'new-dir-x', 'plain.txt'), tmpdir(), {}).why, '', 'SID-162 review: a new file in a new dir outside a repository');
assert.equal(envTool(join(other, 'src/new.ts'), other, {}).why, '', 'SID-162 review: a normal write in a repository');
// Case-insensitive comparison on darwin and win32 (default case-insensitive file systems), exact elsewhere.
assert.ok(pathWithin('/r/.GIT/Hooks/pre-commit', '/r/.git/hooks', true) && !pathWithin('/r/.GIT/Hooks/pre-commit', '/r/.git/hooks', false) && pathWithin('/r/.git/hooks/x', '/r/.git/hooks', false), 'SID-162 review: pathWithin folds case only when asked');
// Shell guard: ln to or from a hook or config file, and chmod/chown through a link into a hooks dir.
const lnDeny = ['ln -s .git/hooks/post-commit pc3', 'ln .git/hooks/pre-commit hl4', 'ln -sf ../.git/hooks/x docs/pc', 'ln -s .git/sflow-hooks/pre-push sp', `ln ${join(sepGit, 'hooks/pre-commit')} hl5`, 'ln -s .git/config cfg',
  'ln -t docs .git/hooks/pre-commit', 'ln -s "$PWD/.git/hooks/post-merge" pm', 'chmod +x pc', 'chmod 755 pc2', 'chmod +x .git/hooks/pre-commit', 'chown me pc', 'chmod +x hl'];
for (const c of lnDeny) assert.ok(denied('pre-bash.mjs', bash(c, hookRepo)), `SID-162 review: shell must deny ${c}`);
for (const c of ['ln -s a b', 'ln -s ../src/a docs/b', 'ln docs/one docs/three', 'chmod +x docs/one', 'chmod -R u+w src', 'ln -s hooks/harness hh', 'chmod +x dl'])
  assert.ok(!denied('pre-bash.mjs', bash(c, hookRepo)), `SID-162 review: shell must allow ${c} (${reasonOf(run('pre-bash.mjs', bash(c, hookRepo)))})`);

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
const solo = makeScratch('harness-solo-');
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
  const scratch = (name) => { const d = makeScratch(`harness-sid65-${name}-`); made.push(d, `${d}.origin.git`); return d; };
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
    const nonRepo = makeScratch('harness-sid65-k8n-');
    made.push(nonRepo);
    for (const cmd of ['gh pr merge 1 -R o/r', 'git push -f origin HEAD:main']) assert.ok(verdict(nonRepo, cmd).deny, `k8 non-repo: must deny: ${cmd}`);
    for (const cmd of ['ls', 'git clone /nonexistent/x.git', 'git init', 'gh pr view 1 -R o/r']) assert.ok(!verdict(nonRepo, cmd).deny, `k8 non-repo: must allow: ${cmd}`);
    for (const cmd of ['echo x > .harness.json', 'cp x/.harness.json .']) assert.ok(verdict(nonRepo, cmd).deny, `k8 non-repo: SID-66 must deny: ${cmd}`);
    for (const cmd of ['cat .harness.json', 'cp .harness.json /tmp/', 'cp .harness.json backup/']) assert.ok(!verdict(nonRepo, cmd).deny, `k8 non-repo: SID-66 must allow: ${cmd} (${verdict(nonRepo, cmd).why})`);

    // k10. SID-82/83: a committed policy that exists but is unusable (invalid JSON, not an object, over the 1 MB cap) is BROKEN: strict defaults,
    // nothing falls through to the next candidate, config() never throws, and pre-bash still fails closed on EVERY command, as a parse error
    // always did (Siddhant, Oct 31: B ships fail-closed with no read or git status allowance), now naming the reason and who fixes it.
    const { POLICY_MAX } = await import(join(hooks, 'lib.mjs'));
    const policyRaw = (d, branch, text) => { // like policyOn, but commits the exact bytes given (written by node, not the shell)
      sh(d, `git checkout -q -B ${branch} $(git rev-parse -q --verify origin/${branch} || echo HEAD)`);
      writeFileSync(join(d, '.harness.json'), text);
      sh(d, `git add .harness.json && git commit -qm policy && git push -q origin ${branch} && git checkout -q feat/x && git branch -q -D ${branch}`);
    };
    const pad = (n) => { const head = '{"allowMerge":true,"protectedBranches":["main"],"pad":"', tail = '"}'; return head + 'x'.repeat(n - head.length - tail.length) + tail; };
    const stillDenied = ['ls', 'git status', 'git fetch origin', 'npm test', 'gh pr view 1', 'cat .harness.json'];
    const holdsBroken = (d, tag, reasonRe) => {
      const c = config(d);
      assert.ok(c.broken && c.present === false && c.allowMerge === false && c.gate.length === 0 && c.dod.length === 0, `${tag}: broken, strict defaults`);
      assert.deepEqual([c.source, c.base, c.broken.base, typeof c.baseSha], ['origin/main', 'main', 'main', 'string'], `${tag}: origin/main is the policy candidate`);
      assert.match(c.broken.reason, reasonRe, `${tag}: reason`);
      for (const n of ['main', 'master']) assert.ok(c.protectedBranches.includes(n), `${tag}: ${n} protected`);
      for (const cmd of [...stillDenied, 'git push origin main', 'git push origin feat/x', 'gh pr merge 1', 'gh pr create --fill', 'gh pr ready 1']) {
        const v = verdict(d, cmd);
        assert.ok(v.deny, `${tag}: must deny: ${cmd}`);
        assert.ok(v.why.includes(`the .harness.json on origin/main ${c.broken.reason}; strict defaults apply`), `${tag}: ${cmd} names the broken policy and reason (${v.why})`);
        assert.match(v.why, /until a human fixes it on main/, `${tag}: ${cmd} says who fixes it`);
        assert.match(v.why, /^harness hook error \(failing closed\): /, `${tag}: ${cmd} fails closed as before`);
      }
      const ctx = run('session-start.mjs', { hook_event_name: 'SessionStart', cwd: d }).hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes(`the .harness.json on origin/main ${c.broken.reason}`), `${tag}: SessionStart surfaces the note`);
      assert.equal(run('stop.mjs', { cwd: d, stop_hook_active: false }), null, `${tag}: Stop is silent, as with no policy`);
    };
    // 1. invalid JSON on origin/main; a permissive policy on master must not be used
    const k10a = mk('k10a');
    policyRaw(k10a, 'main', '{"allowMerge": tru');
    policyRaw(k10a, 'master', JSON.stringify({ protectedBranches: [], allowMerge: true }));
    holdsBroken(k10a, 'k10 invalid JSON', /^is not valid JSON \(.+\)$/);
    assert.ok(verdict(k10a, 'gh pr merge 1').why.includes(config(k10a).broken.reason), 'k10 invalid JSON: the deny text carries the parse error');
    // 2. over the cap on main, permissive on master: master is not consulted
    const k10b = mk('k10b');
    policyRaw(k10b, 'main', pad(POLICY_MAX + 1));
    policyRaw(k10b, 'master', JSON.stringify({ protectedBranches: [], allowMerge: true }));
    holdsBroken(k10b, 'k10 over 1 MB', new RegExp(`^is over 1 MB \\(${POLICY_MAX + 1} bytes\\)$`));
    assert.equal(config(k10b).allowMerge, false, 'k10 over 1 MB: master allowMerge not used');
    // 3. exactly at the cap still works
    const k10c = mk('k10c');
    policyRaw(k10c, 'main', pad(POLICY_MAX));
    const c10c = config(k10c);
    assert.deepEqual([c10c.present, c10c.broken ?? null, c10c.allowMerge, c10c.source], [true, null, true, 'origin/main'], 'k10 at the cap: policy read');
    assert.ok(!verdict(k10c, 'gh pr merge 1').deny, 'k10 at the cap: committed allowMerge honoured');
    // 4. valid JSON that is not an object
    for (const [i, text] of [['arr', '[]'], ['str', '"x"'], ['num', '42'], ['null', 'null']]) {
      const d = mk(`k10d${i}`);
      policyRaw(d, 'main', text);
      holdsBroken(d, `k10 non-object ${text}`, /^is not valid JSON for a policy \(it must be an object/);
    }
    // 5. a missing file on main still falls through to master (SID-65 behaviour unchanged)
    const k10e = mk('k10e');
    policyOn(k10e, 'master', { gate: [] });
    assert.deepEqual([config(k10e).present, config(k10e).source, config(k10e).broken ?? null], [true, 'origin/master', null], 'k10 no file on main: falls through to master');

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
  const scratch = (name) => { const d = makeScratch(`harness-sid66-${name}-`); made.push(d, `${d}.origin.git`); return d; };
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
    // main's file-writing forms (sort -o, uniq IN OUT, git --output) onto a policy path, plain and wrapped/cd'd
    'sort -o .harness.json f', 'sort f -o .harness.json', 'sort -uo .harness.json f', 'sort --output=.harness.json f', 'sort --output .harness.json f', 'nice sort -o .harness.json f', 'sort -o .claude/settings.local.json f', 'cd .claude && sort -o settings.json f',
    'uniq a .claude/settings.json', 'uniq -c a .harness.json', 'git log -1 --output=.harness.json', 'git diff --output .claude/settings.json', 'git -C sub log --output=.harness.json',
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
    // the same tools reading a policy file, or writing elsewhere
    'sort .harness.json', 'sort -o /tmp/x .harness.json', 'uniq .harness.json', 'uniq .harness.json /tmp/x', 'git log --output=/tmp/x', 'cat .harness.json | sort',
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
// Regression check: the guard must not allow anything an earlier main denied, except the allowlist. Corpus: every command sent through bash() above plus a generated body x template set.
// SID-253: both sides are the real pre-bash.mjs, of each baseline commit and of this tree, so analyzeWrites, lineReason and segmentReason all count, on a feature branch and on main.
const gitHere = (...a) => execFileSync('git', ['-C', here, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
// Seven baselines: main at 6bd7438 (with #16, SID-79/80), main at f70d9bd (with #13, SID-65), 086c230 (the base the quote-aware PR started from), 5c959d2 (main when SID-155 started), 91c6b08 (main before SID-191), b07b159 (main before SID-243) and e7d30ea (main before SID-247). Nothing any of them denies may become allowed, except the allowlist.
const pick = (revs) => revs.find((r) => { try { gitHere('rev-parse', '--verify', '-q', `${r}^{commit}`); return true; } catch { return false; } });
const guardCfg = { protectedBranches: ['main', 'master'], allowMerge: false };
const baselines = [];
const hookOfCommit = (rev) => {
  const dir = makeScratch('harness-main-');
  for (const f of gitHere('ls-tree', '--full-tree', '--name-only', `${rev}:workflows/hooks`).split('\n')) writeFileSync(join(dir, f), gitHere('show', `${rev}:workflows/hooks/${f}`));
  return join(dir, 'pre-bash.mjs');
};
for (const revs of [['6bd7438', 'origin/main'], ['f70d9bd'], ['086c230'], ['5c959d2'], ['91c6b08'], ['b07b159'], ['e7d30ea']]) { // 5c959d2: main when SID-155 started; 91c6b08: main before SID-191; b07b159: main before SID-243; e7d30ea: main before SID-247
  const rev = pick(revs);
  assert.ok(rev, `regression check needs history: none of ${revs.join(', ')} exists here; fetch full history (git fetch --unshallow origin main)`);
  baselines.push({ sha: gitHere('rev-parse', '--short', rev), hook: hookOfCommit(rev) });
}
const newDenies = (c, b) => Boolean(newRules.lineReason(c) || newRules.segmentReason(c, guardCfg, b)); // SID-191: the whole pre-bash rule path (quoting resolved, expansions probed)
const BODIES = ['git push -f origin main', 'git push origin main', 'git push origin HEAD:main', 'git push --mirror', 'git reset --hard', 'git branch -D x', 'git clean -fdx', 'git checkout .', 'git commit --no-verify -m x', 'git stash clear', 'gh pr merge 1', 'gh api -X PUT repos/o/r/pulls/1/merge', 'npm publish'];
// Round-7 templates (brace forms, sort -o, uniq -, git log --output, sort --co=). Their quoted payload runs nowhere, so baselines and the guard both allow
// the bare forms and the gap check asserts nothing for them; ROUND7_SEMI (SID-110) adds `true; <template>` and `<template>; <body>` so they bite.
const ROUND7 = [
  (x) => `git push --{e,e}='true; ${x}' origin feat/x`, (x) => `git push -{-,-}e='true; ${x}' origin feat/x`, (x) => `git fetch --u{p,p}l='true; ${x}' origin`, (x) => `git push {--e,--e}='true; ${x}' origin feat/x`,
  (x) => String.raw`printf '[core]\nfsmonitor = "true; ${x}"\n' | sort -o .git/config`, (x) => `git log -1 --output=.git/config --format='[core]%nfsmonitor = "true; ${x}"'`, (x) => String.raw`printf '${x}\n' | uniq - f.sh`,
  (x) => `git log -1 --output=f.sh --format='${x}'`, (x) => String.raw`printf '${x}\n' | sort -o f.sh`, (x) => String.raw`printf '${x}\n' | uniq - .git/config`, (x) => `sort --co='x; ${x}' f`
];
const TEMPLATES = [(x) => x, (x) => `true; ${x}`, (x) => `bash -c 'true; ${x}'`, (x) => `bash -c "true && ${x}"`, (x) => `bash -c -- 'true; ${x}'`, (x) => `sh -c '${x}'`, (x) => `setsid sh -c 'true; ${x}'`, (x) => `busybox sh -c 'true; ${x}'`, (x) => `fish -c 'true; ${x}'`,
  (x) => `docker exec c sh -c 'true; ${x}'`, (x) => `tmux new 'true; ${x}'`, (x) => `perl -e 'system("true; ${x}")'`, (x) => `parallel ::: 'true; ${x}'`, (x) => `xargs sh -c 'true; ${x}'`, (x) => `ssh host 'cd x; ${x}'`, (x) => `nohup sh -c 'true; ${x}'`,
  (x) => String.raw`echo $'\''; ${x}`, (x) => String.raw`echo $'a\'b' && ${x}`, (x) => String.raw`echo $'\''; ${x}; echo \'`,
  (x) => L('cat <<EOF', "it's", 'EOF', x), (x) => L('cat > f <<EOF', "don't", 'EOF', x), (x) => L("cat <<'EOF'", "it's", 'EOF', x), (x) => L('cat <<-EOF', "\tit's", '\tEOF', x), (x) => L('bash <<E', x, 'E'), (x) => L('cat <<EOF | sh', x, 'EOF'), (x) => L('cat <<EOF', `$(${x})`, 'EOF'),
  (x) => x.replace(/ (\S+)$/, ' \\\n $1'), (x) => `echo "true; ${x}" | sh`, (x) => `echo 'true; ${x}' > f.sh && bash f.sh`, (x) => `git -c core.pager='true; ${x}' log`, (x) => `GIT_PAGER='true; ${x}' git log`, (x) => `echo "$(${x})"`, (x) => `${x} 2>&1`, (x) => `2>&1 ${x}`,
  (x) => `git fetch --upl='true; ${x}' origin`, (x) => `git push --receive-p='true; ${x}' origin feat/x`, (x) => `git push --exe 'true; ${x}' origin feat/x`, (x) => `git push --e='true; ${x}' origin feat/x`, (x) => `sort --com='x; ${x}' f`,
  ...ROUND7,
  (x) => `echo '${x}' | sh`, (x) => String.raw`printf '${x}\n' | bash`, (x) => `echo '${x}' | tee >(sh)`, (x) => `sh <(echo '${x}')`, (x) => `echo '${x}' | xargs -I{} sh -c {}`, (x) => `echo ${x} | sh`, (x) => `echo '${x}' > >(sh)`,
  (x) => `source <(echo '${x}')`, (x) => `. <(echo '${x}')`, (x) => `echo '${x}' | source /dev/stdin`, (x) => `echo '${x}' | xargs -I{} sh -c 'eval {}'`, (x) => `echo '${x}' | xargs sh -c 'eval "$@"' _`,
  (x) => `sh -c "$(echo '${x}')"`, (x) => `bash -c "\`printf '${x}'\`"`, (x) => `eval "$(echo '${x}')"`, (x) => `eval \`echo ${x}\``];
const ROUND7_SEMI = ROUND7.flatMap((t) => [(x) => `true; ${t(x)}`, (x) => `${t(x)}; ${x}`]);
TEMPLATES.push(...ROUND7_SEMI);
const generated = BODIES.flatMap((b) => TEMPLATES.map((t) => t(b)));
// SID-110: `<template>; <body>` runs the body as its own command, so the current guard must deny every one, on a feature and a protected branch.
for (const t of ROUND7_SEMI.filter((_, k) => k % 2)) for (const x of BODIES) for (const b of ['feat/x', 'main']) assert.ok(newDenies(t(x), b), `SID-110 ; variant must be denied on ${b}: ${t(x)}`);
// SID-243: the new deny forms, must-allows, near misses, pinned collateral and generated variants (asserted in scripts/test-diff-guard.mjs) join the corpus.
const sid243Denies = [...MUST_DENY_CONFIG, ...MUST_DENY_OVERRIDE, ...MUST_DENY_OPAQUE, ...MUST_DENY_ATTR, ...MUST_DENY_WRAPPER, ...WRAP_VARIANTS, ...QUOTE_VARIANTS, ...NESTED_QUOTE_VARIANTS];
const everything = [...new Set([...corpus, ...generated, ...sid243Denies, ...sid243Allow, ...sid243Collateral])];
// Each entry is a command main denied only because it scans quoted text, and the new guard allows because nothing in the command can run that text.
const ALLOWLIST = [
  ['echo "a && git push -f"', 'quoted text of echo, which runs nothing'],
  ["git commit -m 'x; git reset --hard'", 'quoted text of git commit -m'],
  ["git push origin feat/x # don't push main", 'a real comment, never run'],
  [L('git add -A && git commit -m "$(cat <<\'EOF\'', "fix: don't; git reset --hard", 'EOF', ')"'), 'quoted-delimiter heredoc data of cat inside git commit -m; every segment is git add, git commit or cat, none runs it'],
  [L('git push \\', ' origin feat/x'), 'line continuation: it is `git push origin feat/x`; main saw a bare `git push \\` and denied it on the protected branch'],
  ['git replace -l', 'list form only prints replace refs; 086c230 denied every git replace, main since #13 (f70d9bd) denies only the forms that write them'],
  ['git replace --list', 'list form only prints replace refs; 086c230 denied every git replace, main since #13 (f70d9bd) denies only the forms that write them'],
  [sid247Approved, 'SID-247, approved by Siddhant via the CTO, Nov 1 2026, 6:10 PM IST: git merge or rebase whose only change from a denied verdict is a bare -n and/or glued -X words. A predicate, because several command strings become newly allowed'],
];
const allowlisted = (c) => ALLOWLIST.some(([m]) => (typeof m === 'string' ? m === c : m(c)));
assert.equal(ALLOWLIST.length, 8, 'the allowlist is 7 exact strings and the SID-247 matcher; a new entry needs its own approval');
const verdictsOf = (hook) => { const byBranch = Object.fromEntries(BRANCHES.map((b) => [b, realDenies(hook, everything, b)])); return (c, b) => byBranch[b].get(c); };
const hookNow = join(hooks, 'pre-bash.mjs'), now = verdictsOf(hookNow);
const nowDenies = new Map(everything.flatMap((c) => BRANCHES.map((b) => [`${b} ${c}`, now(c, b)])));
// SID-253: the batch must give what one real process per command gives. Each side (deny and allow) of an even spread of the corpus; SFLOW_VERDICT_SAMPLE widens it for a one-off proof.
const verdictSample = (denies, b, want) => { const n = Number(process.env.SFLOW_VERDICT_SAMPLE ?? 6), side = everything.filter((c) => denies(c, b) === want), step = Math.max(1, Math.floor(side.length / n)); return side.filter((_, k) => k % step === 0).slice(0, n); };
const checkBatch = (hook, denies, label) => {
  let n = 0;
  for (const b of BRANCHES) for (const want of [true, false]) for (const c of verdictSample(denies, b, want)) { assert.equal(onceDenies(hook, c, b), want, `SID-253: batch and one real process disagree on ${b} at ${label}: ${c}`); n++; }
  return n;
};
let batchChecked = checkBatch(hookNow, now, 'this tree');
const lostAny = new Set();
for (const base of baselines) {
  const was = verdictsOf(base.hook);
  base.denies = was;
  batchChecked += checkBatch(base.hook, was, base.sha);
  const rows = everything.flatMap((c) => BRANCHES.map((b) => ({ c, b, was: was(c, b), now: now(c, b) })));
  const lost = rows.filter((r) => r.was && !r.now);
  lost.forEach((r) => lostAny.add(r.c));
  assert.deepEqual([...new Set(lost.filter((r) => !allowlisted(r.c)).map((r) => r.c))], [], `regression vs ${base.sha}: main denied these, the new guard allows them`);
  const gaps = rows.filter((r) => generated.includes(r.c) && !r.now);
  assert.deepEqual(gaps.filter((r) => r.was).map((r) => `${r.b}: ${r.c}`), [], `a generated body x template that ${base.sha} denied must stay denied`);
  console.log(`regression vs ${base.sha}: ${everything.length} commands x 2 branches, main denies ${rows.filter((r) => r.was).length}, new allows ${lost.length} (all allowlisted: ${[...new Set(lost.map((r) => r.c))].length} commands, ${lost.filter((r) => !sid247Approved(r.c)).length} of the verdicts outside the SID-247 entry, allowlist ${ALLOWLIST.length} entries)`);
  console.log(`generated ${generated.length} combinations x 2 branches vs ${base.sha}: new denies all but ${gaps.length} that main also allows`);
}
console.log(`SID-253: batch verdicts match one real process per command on all ${batchChecked} sampled verdicts`);
// A one-off report, not a gate: did a merged PR newly allow what its parent denied, outside the allowlist? SFLOW_MERGED_PAIRS=<report file>.
if (process.env.SFLOW_MERGED_PAIRS) {
  const lines = [];
  for (const [parent, child, pr] of [['f285cd5', 'c51848e', '#32'], ['91c6b08', 'c51848e', '#32 (vs main before SID-191)'], ['c51848e', '3a507e1', '#34'], ['b07b159', 'e7d30ea', '#36']]) {
    const was = verdictsOf(hookOfCommit(parent)), is = verdictsOf(hookOfCommit(child));
    const lost = everything.flatMap((c) => BRANCHES.filter((b) => was(c, b) && !is(c, b)).map((b) => ({ c, b }))), out = lost.filter((r) => !allowlisted(r.c));
    console.log(`merged-PR check ${pr} ${child} vs ${parent}: ${lost.length} newly allowed, ${out.length} outside the allowlist`);
    for (const { c, b } of out) lines.push(`${pr} ${child} vs parent ${parent}, branch ${b}: parent DENY, ${child} ALLOW: ${JSON.stringify(c)}`);
  }
  // What PR #36 reported, 0/8/12/0/0/0 new allows from the old runner, re-measured: e7d30ea as the guard, each earlier baseline as main, real entrypoints on both sides.
  const merged = verdictsOf(hookOfCommit('e7d30ea'));
  for (const base of baselines.filter((x) => !x.sha.startsWith('e7d30ea'))) console.log(`e7d30ea vs ${base.sha}: ${everything.flatMap((c) => BRANCHES.filter((b) => base.denies(c, b) && !merged(c, b))).length} new allows`);
  writeFileSync(process.env.SFLOW_MERGED_PAIRS, `${lines.join('\n')}\n`);
}
// SID-191 collateral: what the guard newly denies compared with main 91c6b08, over the whole corpus (the SID-191 cases themselves excluded). Pinned, so any growth is a visible test change.
{
  const main191 = baselines.find((x) => x.sha.startsWith('91c6b08'));
  const ours = new Set([...r32Ours, ...sid191, ...sid191More, ...splitVariants, ...sid191Review, ...reviewVariants, ...sid191Rev2, ...rev2Variants, ...sid191LiteralCollateral, ...sid243Denies, ...sid247All]);
  const fresh = [...new Set(everything.filter((c) => !ours.has(c) && ['feat/x', 'main'].some((b) => nowDenies.get(`${b} ${c}`) && !main191.denies(c, b))).map((c) => c.split(repo).join('<REPO>').split(sepGit).join('<SEP>.gitdir')).map((c) => (c.length > 500 ? `sha256:${createHash('sha256').update(c).digest('hex')}:${c.length}` : c)))].sort(); // the scratch repo path differs per run; entries over 500 chars are pinned by hash and length
  // Exact list (scripts/sid191-collateral.json): a command that becomes newly denied, or stops being, fails here and the file is edited in review.
  const pinned = JSON.parse(readFileSync(join(here, 'sid191-collateral.json'), 'utf8'));
  assert.deepEqual(fresh, [...pinned].sort(), `SID-191 pinned collateral vs 91c6b08 changed (${fresh.length} now, ${pinned.length} pinned); review the diff and update scripts/sid191-collateral.json`);
  console.log(`SID-191 collateral vs 91c6b08: ${fresh.length} corpus commands newly denied, all pinned in scripts/sid191-collateral.json`);
}
for (const [m, why] of ALLOWLIST) {
  const hit = typeof m === 'string' ? (c) => c === m : m;
  assert.ok(everything.some(hit), `stale ALLOWLIST entry (not in the corpus): ${why}`);
  assert.ok([...lostAny].some(hit), `stale ALLOWLIST entry (no baseline denies it, or the new guard denies it): ${why}`);
}
console.log(`SID-247 allowlist entry covers ${[...lostAny].filter(sid247Approved).length} corpus commands`);
if (process.env.SID247_LIST) console.log([...lostAny].filter(sid247Approved).join('\n'));

console.log('hooks ok');
