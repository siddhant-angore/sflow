// SID-247, CTO review 5732381973: lines where git reads a different word as its subcommand than the guard does. Each is allowed at 34a4f99 and denied on main e7d30ea unless a comment says otherwise.
const SUBS = ['merge', 'rebase'];
const nest = (x) => (x.includes("'") ? `"${x.replace(/(["\\$`])/g, '\\$1')}"` : `'${x}'`);
const bothSubs = (rows) => [...new Set(rows.flatMap((r) => SUBS.map((s) => r.replace(/\bmerge\b/, s))))];

// Group 1: the value expands to nothing, so git takes `merge` as the value and `commit` as the subcommand.
const EMPTY_VALUES = ['$E', '$(true)', '`true`', '${E:-}'];
const VALUED_OPTIONS = ['--namespace', '--git-dir', '--work-tree', '-C', '-c'];
export const EXPANDS_TO_NOTHING = bothSubs([
  ...VALUED_OPTIONS.flatMap((o) => EMPTY_VALUES.map((v) => `git ${o} ${v} merge commit -n -m x`)),
  `bash -c 'git --namespace $E merge commit -n -m x'`,
  'env git --namespace $E merge commit -n -m x',
]);

// Group 2: the value word-splits.
export const WORD_SPLITS = bothSubs([
  "V='x commit -n -m y --'; git --namespace $V merge -n",
  'git --namespace $V merge -n',
  "V='x commit -n -m y --'; git --namespace ${V} merge -n",
  'git --namespace ${V} merge -n',
]);

// Group 3: an escaped space or quote in a value; the tokenizer and bash end the word in different places.
export const ESCAPED_VALUES = bothSubs([
  'git --namespace a\\ merge commit -n -m x',
  'git -c a.b=x\\ merge commit -n -m x',
  `sh -c 'git --namespace a\\ merge commit -n -m x'`,
  'git --namespace "\\" merge " commit -n -m x',
  "git --namespace $'\\' merge ' commit -n -m x",
]);

// Group 4: env -S and every spelling of it; what it splits is read as a script.
export const ENV_SPLIT = bothSubs([
  `env -S 'git --namespace"" merge commit -n -m x'`,
  `env --split-string='git --namespace"" merge commit -n -m x'`,
  `env -S 'git --shallow-file merge commit -n -m x'`,
  `env --split-string 'git --namespace"" merge commit -n -m x'`,
  `env -iS 'git --namespace"" merge commit -n -m x'`,
  `env -S'git --namespace"" merge commit -n -m x'`,
  `env --split-str='git --namespace"" merge commit -n -m x'`,
]);

export const REVIEW_3_GROUPS = { 'expands to nothing': EXPANDS_TO_NOTHING, 'word splitting': WORD_SPLITS, 'escaped value': ESCAPED_VALUES, 'env -S': ENV_SPLIT };
export const REVIEW_3 = Object.values(REVIEW_3_GROUPS).flat();

const WRAPPERS = [(x) => `bash -c ${nest(x)}`, (x) => `sh -c ${nest(x)}`, (x) => `env ${x}`, (x) => `command ${x}`, (x) => `sudo ${x}`];
export const REVIEW_3_GENERATED = [...new Set(REVIEW_3.flatMap((r) => WRAPPERS.map((w) => w(r))))].filter((r) => !REVIEW_3.includes(r));

// Past the four groups: what the positive check must not prove literal, each condition by itself.
const HIDDEN = 'git --namespace $E merge commit -n -m x';
export const NOT_PROVEN_LITERAL = [
  // whitespace to the tokenizer, part of a word to bash, so git reads x<blank>merge as the value and commit as the subcommand
  ...[' ', '\r', '\f', '\v', ' ', ' ', '﻿'].map((blank) => `git --namespace x${blank}merge commit -n -m x`),
  // a word before git
  'FOO=$X git merge -n main', 'FOO=`true` git merge -n main', 'FOO=a\\ b git merge -n main', 'env A=$B git merge -n main', 'sudo -u $U git merge -n main', "FOO='$X' git merge -n main", 'FOO="`true`" git merge -n main',
  // a redirection in the prefix
  '2>&1 git merge -n main', 'git >f merge -n main', 'git >$E merge -n main',
  // unquoted glob and brace characters
  'git -C ~ merge -n main', 'git -C ~/x rebase -n main', 'FOO=~ git merge -n main', 'FOO=* git merge -n main', 'FOO=? git merge -n main', 'FOO=[a] git merge -n main', 'FOO={a,b} git merge -n main', 'git -C x* merge -n main', 'git -C x? merge -n main', 'git -C [x] merge -n main', 'git -C {x,y} merge -n main', 'git -C x] merge -n main', 'git -C x} merge -n main',
  // quoted parts that are not simple
  'git -C "a\\"b" merge -n main', "git -C 'a\\b' merge -n main", "git -C 'a$b' merge -n main", "git -C 'a`b' merge -n main", 'git -C "a\\b" merge -n main', 'git -C "$D" merge -n main', 'git -C "`true`" merge -n main',
  // the bound: every word through the subcommand, not only the first option
  'git -C . --namespace $E merge commit -n -m x', 'git --no-pager -C . --namespace a\\ merge commit -n -m x',
  // every simple command, wherever it runs
  `git merge -n main && ${HIDDEN}`, `${HIDDEN} && git merge -n main`, 'true; git -C $E merge -n main',
  `(${HIDDEN})`, `{ ${HIDDEN}; }`, `if ${HIDDEN}; then true; fi`, `! ${HIDDEN}`, `time ${HIDDEN}`, `nice ${HIDDEN}`, `nohup ${HIDDEN}`, `timeout 5 ${HIDDEN}`, `xargs ${HIDDEN}`, `exec ${HIDDEN}`, `g"i"t --namespace $E merge commit -n -m x`, `\\${HIDDEN}`,
  `echo $(${HIDDEN})`, `echo "$(${HIDDEN})"`, `cat <(${HIDDEN})`, `xargs sh -c '${HIDDEN}'`, `echo "${HIDDEN}" | sh`, `bash <<E\n${HIDDEN}\nE`, `cat <<E | sh\n${HIDDEN}\nE`,
  `su -c '${HIDDEN}'`, `ssh h '${HIDDEN}'`, `watch '${HIDDEN}'`, `flock f -c '${HIDDEN}'`, `script -c '${HIDDEN}'`,
  // env -S spelled any way env accepts, on any command the line runs. The env -iS, -vS, --s and --sp lines were allowed on e7d30ea too: reading them is a tightening
  `"env" -S 'git --namespace"" merge commit -n -m x'`, `e\\nv -S 'git --namespace"" merge commit -n -m x'`, `/usr/bin/env -S 'git --namespace"" merge commit -n -m x'`, `env -"S" 'git --namespace"" merge commit -n -m x'`, `env -i -S 'git --namespace"" merge commit -n -m x'`, `env -vS 'git --namespace"" merge commit -n -m x'`, `env A=1 -S 'git --namespace"" merge commit -n -m x'`, `env --s='git --namespace"" merge commit -n -m x'`, `env --sp 'git --namespace"" merge commit -n -m x'`,
  `env -S 'git merge -n main'`, `env -iS 'git merge -n main'`, `env --split-string='git merge -n main'`, `env --spl 'git merge -n main'`, `env -S'git merge -n main'`, `git merge -n main; env -S 'git status'`, `bash -c "env -S 'git merge -n main'"`,
  `env -iS 'git commit -n -m x'`, `env --split-str='git commit -n -m x'`, `env --s 'git push -f origin main'`,
];

// What the positive check does prove: plain words, and quoted parts with no backslash, $ or backtick. The guard's tokenizer ends such a word where bash does, whitespace inside the quotes included.
export const PROVEN_LITERAL = [
  'git -c "core.pager=less -R" rebase -n main', "git -c 'core.pager=less -R' merge -n main", 'git -C "some dir" rebase -n main', "git -C 'some dir' merge -n main", 'git -C "a b"c merge -n main', 'git --namespace=x merge -n main', 'git --namespace x merge -n main',
  'env git merge -n main', 'env FOO=1 git merge -n main', 'FOO=1 git merge -n main', 'sudo git merge -n main', 'command git rebase -n main', 'timeout 5 git merge -n main', 'nice git merge -n main', '/usr/bin/git merge -n main', '"git" merge -n main',
  'if git merge -n main; then true; fi', '! git merge -n main', 'cd /tmp && git merge -n main', 'cd $D && git merge -n main', "bash -c 'git -C . merge -n main'",
  'git merge -n main 2>&1', 'git merge -n main >f',
];
