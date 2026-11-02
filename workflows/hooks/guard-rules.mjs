import { posix } from 'node:path';
import { canon, clip, GIT_ARG, gitWrites, isPolicyPath, normalize, outerCommands, policyDeny, policyGlobHit, quotesAreData, rawSegments, segments, sortOut, stripRedirs, take, uniqOut, unwrap, WRAPPERS } from './lib.mjs';
// Pure rule table over one normalized shell segment. Returns the reason to deny, or null.
const headRef = (r) => r === 'HEAD' || r === '@';
// The protected branch a refspec pushes to (+ stripped, no colon means dst = src, HEAD and @ resolve to the current branch), or null. viaHead: the name came from the checkout, not from the text.
const protectedTarget = (tok, prot, branch) => {
  const p = tok.replace(/^\+/, '').split(':'), raw = p.length > 1 ? p.pop() : p[0];
  const dst = headRef(raw) ? branch : raw.replace(/^refs\/heads\//, '');
  return prot.includes(dst) ? { name: dst, viaHead: headRef(raw) } : null;
};

const NO_BRANCH = "git can't tell which branch this push updates here (no work tree, or the command targets another repository), so name the branch: git push origin <branch>";

// Does the raw command point git at another repository or directory than the hook's cwd? Then the hook's branch and policy are not the target's.
// Errs toward true: that only means a push must name its branch.
const GLOBAL_WITH_VALUE = /^(-c|-C|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env)$/;
const RETARGET_OPT = /^(-C|--git-dir|--work-tree)(=|$)|^-C./;
export function retargets(cmd) {
  if (/(^|[\s;&|("'`{])GIT_(DIR|WORK_TREE)=/.test(cmd)) return true;
  const segs = cmd.split(/&&|\|\||;|\||\n/);
  let cd = false;
  for (const seg of segs) {
    const toks = seg.trim().split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      if (!/(^|\/)git$/.test(toks[i].replace(/^["'(`{]+/, ''))) continue;
      for (let j = i + 1; j < toks.length; j++) {
        const t = toks[j];
        if (!t.startsWith('-')) break;
        if (RETARGET_OPT.test(t)) return true;
        if (GLOBAL_WITH_VALUE.test(t)) j++;
      }
    }
    if (cd && /(^|[\s"'`])git\b.*\bpush\b/.test(seg)) return true;
    if (/^["'({\s]*((builtin|command)\s+)?(cd|pushd)(\s|$)/.test(seg) || /\b(sh|bash|zsh|dash)\s+-c\s+["']?\s*(cd|pushd)(\s|$)/.test(seg)) cd = true;
  }
  return false;
}

export function pushReason(seg, prot, branch) {
  const m = /^git\s+push\b([\s\S]*)$/.exec(seg);
  if (!m) return null;
  const toks = m[1].trim().split(/\s+/).filter(Boolean), args = [];
  for (let i = 0; i < toks.length; i++) {
    if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(toks[i])) i++; // option argument, not a refspec
    else args.push(toks[i]);
  }
  const flags = args.filter((a) => a.startsWith('-'));
  const refs = args.filter((a) => !a.startsWith('-'));
  if (args.some((a) => /[$`]/.test(a))) return 'push arguments must be literal, no shell expansion';
  if (flags.some((f) => f === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) return 'force push is never allowed; make a new commit';
  if (flags.some((f) => /^--mirror|^--delete|^-d$|^--tags$|^--all$/.test(f))) return 'mirror, delete, --all, and --tags pushes are not allowed';
  if (flags.some((f) => /^--no-verify$/.test(f))) return 'hooks are the gate; --no-verify is not allowed';
  if (refs.some((r) => r.startsWith('+') || /^:/.test(r))) return 'a + refspec or a :branch deletion is a force or a delete';
  if (/^\.\/?$/.test(refs[0] ?? '')) return NO_PUSH_DOT;
  if (refs.slice(1).some((t) => /^refs\/(remotes|replace)\//.test(t.replace(/^\+/, '').split(':').pop()))) return NO_PUSH_DST;
  const targets = refs.slice(1);
  if (targets.length === 0 && branch && prot.includes(branch)) return `you are on protected branch ${branch}; create a feature branch and push that`;
  const hit = targets.map((t) => protectedTarget(t, prot, branch)).find(Boolean);
  if (hit?.viaHead) return `you are on protected branch ${hit.name}; create a feature branch and push that (HEAD/@ here is ${hit.name}: git switch -c <name>, push it and open a PR)`;
  if (hit) return `direct push to a protected branch (${prot.join(', ')}); push a feature branch and open a PR`;
  if (flags.some((f) => f.startsWith('--force-with-lease')) && targets.length === 0 && branch && prot.includes(branch)) return 'lease push to a protected branch';
  if (!branch && (targets.length === 0 || targets.some((t) => headRef(t.replace(/^\+/, '').split(':').pop())))) return NO_BRANCH; // HEAD, @, x:HEAD with no branch checked out: fail closed
  return null;
}

const unquoted = (s) => s.replace(/"[^"]*"|'[^']*'/g, '""');
const NO_MERGE_UNREADABLE = "git can't read this repository, so strict defaults apply; fix the repo config (core.bare, core.repositoryformatversion, core.worktree, include.path); merging stays a human decision until then.";
const NO_SET_HEAD = "harness policy is read from origin/HEAD's branch, so it is not set locally. Use `git remote set-head origin --auto` to sync it with the remote; changing the default branch is a repo-admin action on GitHub.";
const NO_SYMREF = 'refs/remotes/* locate the harness policy, so they are not written locally. Read them with `git symbolic-ref --short refs/remotes/origin/HEAD`; sync them with `git fetch origin` or `git remote set-head origin --auto`.';
const NO_UPDATE_REF = 'refs/remotes/* locate the harness policy, so they are not written locally. Update them with `git fetch origin`; to move a local branch use `git update-ref refs/heads/<name> <commit>`.';
const NO_FETCH_DST = 'refs/remotes/* locate the harness policy, so fetch may not write them through an explicit refspec. Use `git fetch origin <branch>` (it updates origin/<branch> itself) or fetch into a local branch: `git fetch origin <branch>:<local-branch>`.';
// SID-147: the git hooks outside Claude live behind core.hooksPath; dropping the core section, or editing config in an editor, turns them off. sflow.* keys are theirs too.
const NO_HOOKS_CFG = "removing or renaming the core section, changing core.hooksPath or writing sflow.* keys turns off the git hooks that run outside Claude (SID-147); read settings with `git config --get <key>`; changing them is a human action.";
const NO_EDIT_CFG = '`git config --edit` can change any key, core.hooksPath included; set an ordinary key with `git config <key> <value>`.';
const NO_FETCH_CFG = 'remote.<name>.fetch decides what refs/remotes/* hold, which locates the harness policy. Fetch a branch with `git fetch origin <branch>`; read the setting with `git config --get-all remote.origin.fetch`; changing it is a human action.';
const NO_FETCH_OVERRIDE = 'a per-command remote.<name>.fetch override can rewrite refs/remotes/*, which locate the harness policy. Use `git fetch origin <branch>` instead; other -c settings are fine.';
const NO_REPO_EDIT = 'repository settings (including the default branch, which locates the harness policy) are a repo-admin action on GitHub. Read them with `gh repo view --json <fields>`; ask a human to change them.';
const NO_REPLACE = "replace refs can change what the harness policy reads; they're not needed for normal work. List them with `git replace -l`; ask a human if you really need one.";
const NO_HEAD_SYMREF = 'HEAD may only point at a local branch (refs/heads/...), because committing or resetting through HEAD would otherwise move that ref (for example origin/main, which locates the harness policy). Use `git switch <branch>` or `git checkout <branch>`.';
const NO_PUSH_DOT = 'pushing to `.` writes refs in this repository, including refs/remotes/* that locate the harness policy. Move a local branch with `git update-ref refs/heads/<name> <commit>` or `git switch`; push to origin to publish.';
const NO_PUSH_DST = 'push destinations under refs/remotes/ or refs/replace/ can change what the harness policy reads; push a branch instead: `git push origin <branch>`.';
const NO_FAST_IMPORT = "git fast-import can create or reset any ref (including refs/remotes/*, which locate the harness policy) and isn't needed for normal work; commit normally, or ask a human to run an import.";
const NO_STDIN = "git update-ref --stdin can write any ref and its input can't be checked; run one `git update-ref refs/heads/<name> <commit>` per ref instead.";
const NO_DISCOVERY_CFG = 'core.bare, core.repositoryformatversion, core.worktree, include.path and includeIf.* change how git finds and reads this repository, which would stop the harness from reading its policy. Leave them as they are; read them with `git config --get <key>`; if the repository config really needs changing, ask a human.';
// SID-243: these name a program git runs on a diff, the push scan's driver read included. Git's rule: the subsection is everything between the first and last dot, so a driver's name may hold dots or spaces, or be empty.
const NO_DIFF_DRIVER = 'diff.external and diff.<driver>.textconv/.command run a program on every diff, the push secret scan included, so setting or removing one is a human action. Read them with `git config --get diff.external`; `git diff --no-ext-diff` skips them.';
export const NO_INFO_ATTRIBUTES = '.git/info/attributes can point any path at a diff driver or mark it -diff, in no commit a reviewer sees, so agents do not write it. Attributes for the project go in a committed .gitattributes; reading this file with cat or grep is fine.';
const DRIVER_KEY = /^diff\.(?:external|[\s\S]*\.(?:textconv|command))$/i;
const DRIVER_SECTION = /^diff(?:\.[\s\S]*)?$/i;
const DRIVER_PARAM = /(?:^|[\s"'=])diff\.(?:external|[^='"]*\.(?:textconv|command))(?=$|[\s"'=])/i;
// The same keys read off a whole line, for commands the guard doesn't parse (`docker exec c sh -c '...'`, `parallel`, `perl -e`). Quotes block it only when nothing on the line can run them.
const DRIVER_TEXT = /(?:^|[\s"'`;&|(])(?:-c\s*|--config-env[=\s]\s*|GIT_CONFIG_KEY_\d+=)["']?diff\.(?:external|[^=\n]*?\.(?:textconv|command))["']?(?=[\s=;&|)"'`]|$)/i;
// git config's long options. Git takes any unique prefix (`--unset-a`, `--fil`), and an option's value is not an option (`--comment --get k v` writes).
const CONFIG_VALUE_OPTS = ['file', 'blob', 'type', 'default', 'comment', 'value', 'url'];
const CONFIG_OPTS = [...CONFIG_VALUE_OPTS, 'global', 'system', 'local', 'worktree', 'get', 'get-all', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool', 'replace-all', 'add', 'unset', 'unset-all', 'rename-section', 'remove-section', 'list', 'edit', 'bool', 'int', 'bool-or-int', 'bool-or-str', 'path', 'expiry-date', 'no-type', 'null', 'name-only', 'show-origin', 'show-scope', 'includes', 'fixed-value', 'all', 'regexp'];
const CONFIG_WRITES = new Set(['add', 'replace-all', 'unset', 'unset-all']), CONFIG_READS = new Set(['get', 'get-all', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool', 'list']);
function configArgs(w) {
  const opts = new Set(), pos = [];
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (t === '--') { pos.push(...w.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0], prefixed = CONFIG_OPTS.filter((o) => o.startsWith(name));
      const opt = CONFIG_OPTS.includes(name) ? name : prefixed.length === 1 ? prefixed[0] : null;
      if (CONFIG_VALUE_OPTS.includes(opt)) { if (!t.includes('=')) i++; } else if (opt) opts.add(opt);
    } else if (/^-./.test(t)) {
      for (let k = 1; k < t.length; k++) {
        if (t[k] === 'f') { if (k + 1 === t.length) i++; break; }
      }
    } else pos.push(t);
  }
  return { opts, pos };
}
const driverConfigReason = (raw) => {
  const { opts, pos } = configArgs(words(raw).slice(2).map((x) => x.replace(/`$/, ''))); // split() leaves a closing backtick on the last word
  if ((opts.has('rename-section') || opts.has('remove-section') || ['rename-section', 'remove-section'].includes(pos[0])) && pos.some((x) => DRIVER_SECTION.test(x))) return NO_DIFF_DRIVER;
  const k = pos.findIndex((x) => DRIVER_KEY.test(x));
  if (k < 0) return null;
  if ([...opts].some((o) => CONFIG_WRITES.has(o)) || ['set', 'unset'].includes(pos[0])) return NO_DIFF_DRIVER;
  const reads = [...opts].some((o) => CONFIG_READS.has(o));
  return !reads && pos.length > k + 1 ? NO_DIFF_DRIVER : null;
};
const DISCOVERY_KEY = /^(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\..+)$/i;
const DISCOVERY_ENV = /(^|[\s"'=])(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.[^\s='"]+)(?=$|[\s"'=])/i;
const FETCH_KEY = /remote\.[^\s='"]+\.fetch\b/i;
const isRemoteRef = (x) => /^(refs\/)?remotes\//.test(x);
const isReplaceRef = (x) => /^refs\/replace\//.test(x);
// Quote-aware words, so `-m "x y"` stays one word and a quoted ref cannot hide.
const words = (raw) => (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/["']/g, ''));
const symrefReason = (raw) => {
  const w = words(raw).slice(2), pos = [];
  let del = false;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '-m') i++; // reason value
    else if (/^-m./.test(w[i])) continue;
    else if (/^(-d|--delete)$/.test(w[i])) del = true;
    else if (!w[i].startsWith('-')) pos.push(w[i]);
  }
  if (del) return pos.some(isRemoteRef) ? NO_SYMREF : null;
  if (pos.length < 2) return null;
  if (isRemoteRef(pos[0]) || (pos[0] !== 'HEAD' && isRemoteRef(pos[1]))) return NO_SYMREF;
  return pos[0] === 'HEAD' && !pos[1].startsWith('refs/heads/') ? NO_HEAD_SYMREF : null;
};
// `git replace` lists with no args or -l/--list (plus --format and a pattern); every other form writes.
const replaceReason = (a) => {
  if (!a.length) return null;
  let list = false;
  for (let i = 0; i < a.length; i++) {
    if (/^(-l|--list)$/.test(a[i])) list = true;
    else if (a[i] === '--format') i++;
    else if (a[i].startsWith('-') && !a[i].startsWith('--format=')) return NO_REPLACE;
  }
  return list ? null : NO_REPLACE;
};

// An unquoted word that starts with a glob that can match a name starting with `-` (`*`, `?`, `[-]`, `[!a]`, `[^x]`): bash may expand it to a file named like an option (`--exec=...`). Pattern check only; quoted words are literal.
const NO_OPT_GLOB = 'an unquoted glob in a git <sub> argument can expand to a file named like an option (--exec=, --upload-pack=); quote it or spell the names out';
const optGlob = (raw) => { const w = []; for (let [t, r] = take(raw); t !== null; [t, r] = take(r)) w.push(t); return w.slice(2).some((t) => /^[*?]/.test(t) || /[-!^]/.test(/^\[(\]?[^\]]*)\]/.exec(t)?.[1] ?? '')) ? NO_OPT_GLOB : null; };

// SID-247, a loosening approved by Siddhant via the CTO (Nov 1 2026, 6:10 PM IST): to git merge and git rebase, a bare -n is --no-stat and a glued -X value is not flags, so the hook-skip rule doesn't read them.
// The options each command lists in git 2.47: anything else is unknown, including abbreviations, and --exec and -x on purpose (SID-260). In `short`, group 1 is a letter whose value is glued or is the next word, and S and r take only a glued one.
const NO_STAT_OPTIONS = {
  __proto__: null,
  merge: {
    short: /^-[evq]*(?:([mXsF])|[mXsF].+|S.*)?$/,
    flags: new Set('--stat --no-stat --summary --no-summary --log --no-log --squash --no-squash --commit --no-commit --edit --no-edit --ff --no-ff --ff-only --rerere-autoupdate --no-rerere-autoupdate --verify-signatures --verbose --quiet --progress --no-progress --allow-unrelated-histories --no-allow-unrelated-histories --gpg-sign --no-gpg-sign --autostash --no-autostash --overwrite-ignore --no-overwrite-ignore --signoff --no-signoff --verify --abort --quit --continue'.split(' ')),
    values: new Set('--message --file --strategy --strategy-option --into-name --cleanup'.split(' ')),
  },
  rebase: {
    short: /^-[qvfmi]*(?:([sXC])|[sXC].+|[Sr].*)?$/,
    flags: new Set('--keep-base --no-keep-base --verify --quiet --verbose --no-stat --stat --signoff --no-signoff --committer-date-is-author-date --reset-author-date --ignore-date --ignore-whitespace --force-rebase --no-ff --ff --continue --skip --abort --quit --edit-todo --show-current-patch --apply --merge --interactive --rerere-autoupdate --no-rerere-autoupdate --autosquash --no-autosquash --update-refs --no-update-refs --gpg-sign --no-gpg-sign --autostash --no-autostash --rebase-merges --no-rebase-merges --fork-point --no-fork-point --root --reschedule-failed-exec --no-reschedule-failed-exec --reapply-cherry-picks --no-reapply-cherry-picks'.split(' ')),
    values: new Set('--onto --whitespace --empty --strategy --strategy-option'.split(' ')),
  },
};
// Whether a word in option position is a known flag (false) or takes the next word as its value (true); null when git may read it some other way.
const takesNextWord = (word, { short, flags, values }) => {
  if (word.startsWith('--')) {
    const name = word.split('=')[0];
    if (!flags.has(name) && !values.has(name)) return null;
    return word === name && values.has(name);
  }
  const m = short.exec(word);
  return m ? Boolean(m[1]) : null;
};
// A segment with its bare -n and glued -X words taken out, where git reads them as options: before any --, and not as a value. Null when a word can't be classified.
// A word that still holds a quote or escape is read up to it and takes no next word (-m"a b", or -"n", whose resolved form guardSegments also hands over).
const noStatText = (seg) => {
  const m = /^git\s+(\S+)\s+(.*)$/s.exec(seg), options = NO_STAT_OPTIONS[m?.[1]];
  if (!options) return seg;
  const words = m[2].split(/\s+/), kept = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { kept.push(...words.slice(i)); break; }
    if (w === '-n' || /^-X\S/.test(w)) continue;
    kept.push(w);
    if (!w.startsWith('-')) continue;
    const head = w.split(/["'\\]/)[0], next = takesNextWord(head, options);
    if (next === null) return null;
    if (next && head === w && i + 1 < words.length) kept.push(words[++i]);
  }
  return `git ${m[1]} ${kept.join(' ')}`;
};
// The line keeps the rule whole when it holds any prefix of the hook-skip flag (git takes abbreviations; SID-259), or a merge or rebase word that can't be classified.
const isAbbrev = (word, flag) => { const name = word.split('=')[0]; return name.length >= 3 && flag.startsWith(name); };
// CTO review 5730668319: gitSub compares each global option as written, so `--namespace""`, `-"C"` or `-\C` aren't seen to take a value, while git reads the next word as that value and `merge` can hide a real `git commit -n`.
// The first word in git's global-option position, in any piece the guard reads, that isn't plain text and resolves to a dash-word; null when there is none. It reads pieces as written, because normalize() drops these words. Any word that names git counts, so a wrapper needs no list. The value of a plain option is not an option.
// --shallow-file takes a value and gitSub's list lacks it. Adding it there would stop `git --shallow-file reset --hard` reading as a reset, so it is refused here instead; nothing legitimate passes this internal option.
const NOT_LITERAL = /["'\\$`]/, DASH_WORD = /^(?:\$?""|\$?''|\$?['"]|\\)*-/;
const resolvesToDash = (w) => DASH_WORD.test(w) || canon(w).text.replace(/^'/, '').startsWith('-');
function quotedGitOption(cmd, segs) {
  for (const t of [cmd, ...(segs.payloads ?? [])]) for (const piece of rawSegments(t)) {
    const w = toks(stripRedirs(piece));
    for (let i = 0; i < w.length; i++) {
      if (base(canon(w[i]).text.replace(/^'|'$/g, '')) !== 'git') continue;
      for (let j = i + 1; j < w.length; j++) {
        if (w[j] === '--shallow-file' || (NOT_LITERAL.test(w[j]) && resolvesToDash(w[j]))) return w[j];
        if (!w[j].startsWith('-')) break;
        if (GIT_ARG.has(w[j])) j++;
      }
    }
  }
  return null;
}
const NO_QUOTED_GLOBAL = (w) => `the git global option ${clip(w, 80)} is quoted, escaped, an expansion or --shallow-file, so the guard can't tell which word git reads as its value or as the subcommand; write git's global options plainly, unquoted and unescaped (e.g. git -C dir status), or drop them`;
// CTO review 5732381973: the tokenizer and bash can end a word in different places, and then git reads a different subcommand than the guard does. So the skip needs proof, not the absence of a known-bad shape.
// A word they end in the same place: plain characters, and quoted parts with no backslash, $ or backtick, so each closes at the next quote mark in both. Whitespace inside such quotes is text to both.
const PROVEN_WORD = /^(?:[\w@%+=:,./!-]|"[^"\\$`]*"|'[^'\\$`]*')+$/;
// Whitespace to the tokenizer (JS \s), part of a word to bash.
const NOT_A_BASH_BLANK = /[^\S \t\n]/;
const splitsArgs = (w) => /^-[a-zA-Z0-9]*S/.test(w) || isAbbrev(w, '--split-string');
// Every simple command that names git, in every piece the guard reads, is proven from its first word through git's subcommand; and no env on the line splits a string into words.
function provenLiteral(cmd, segs) {
  for (const t of [cmd, ...(segs.payloads ?? [])]) {
    if (NOT_A_BASH_BLANK.test(t)) return false;
    for (const piece of rawSegments(t)) {
      const w = toks(piece);
      for (let i = 0; i < w.length; i++) {
        const name = base(canon(w[i]).text.replace(/^'|'$/g, ''));
        if (name === 'env' && w.slice(i + 1).some(splitsArgs)) return false;
        if (name !== 'git') continue;
        let sub = i + 1;
        while (w[sub]?.startsWith('-')) sub += GIT_ARG.has(w[sub]) ? 2 : 1;
        if (!w.slice(0, sub + 1).every((x) => PROVEN_WORD.test(x))) return false;
      }
    }
  }
  return true;
}
export const keepsHookRule = (segs, cmd) => quotedGitOption(cmd, segs) !== null || !provenLiteral(cmd, segs) || segs.some((s) => s.split(/\s+/).some((x) => isAbbrev(x, '--no-verify')) || noStatText(unquoted(s)) === null);

export function reason(raw, { protectedBranches: prot, allowMerge, unreadable }, branch, noStat = false) {
  const p = pushReason(raw, prot, branch);
  if (p) return p;
  const plain = unquoted(raw), seg = (noStat && noStatText(plain)) || plain;
  const rules = [
    [/^git\s+reset\b.*\s(--hard|--merge)\b/, 'git reset --hard/--merge destroys uncommitted work; commit to a WIP branch or use a fresh worktree; restore named files with git restore <path>'],
    [/^git\s+(checkout|restore|switch)\b.*(\s\.(\s|$)|--discard-changes|\s-f(\s|$)|\s--force(\s|$)|\s--worktree\s+\.)/, 'discarding the working tree is irreversible; restore named files'],
    [/^git\s+clean\b.*\s-[a-zA-Z]*[fdx]/, 'git clean -f/-d/-x deletes untracked files; list them and delete by name'],
    [/^git\s+branch\b.*(\s-D\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|--force\b|--delete\s+--force)/, 'force-deleting a branch is irreversible; use -d'],
    [/^git\s+stash\s+(clear|drop)\b/, 'dropping stashes is irreversible'],
    [/^git\s+(commit|merge|rebase)\b.*(\s--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)/, 'hooks are the gate; --no-verify (-n) is not allowed'],
    [/^git\s+fast-import\b/, NO_FAST_IMPORT],
    [/^git\s+update-ref\b/, (a) => (a.some((x) => x === '--stdin') ? NO_STDIN : a.some(isReplaceRef) ? NO_REPLACE : a.some(isRemoteRef) ? NO_UPDATE_REF : null)],
    [/^git\s+replace\b/, replaceReason],
    [/^git\s+(filter-branch|filter-repo)\b|^git\s+update-ref\s+-d\b|^git\s+reflog\s+expire\b|^git\s+gc\b.*--prune/, 'history rewriting is not allowed'],
    [/^git\s+push\b/, null],
    [/^git\s+(push|fetch|pull|clone|ls-remote|archive|submodule)\b/, () => optGlob(raw)],
    [/^git\s+remote\s+set-head\b/, (a) => (a.some((x) => /^(-a|--auto)$/.test(x)) && !a.some((x) => /^(-d|--delete)$/.test(x)) ? null : NO_SET_HEAD)],
    [/^git\s+symbolic-ref\b/, () => symrefReason(raw)],
    [/^git\s+(fetch|pull)\b/, (a) => { const dsts = a.filter((x) => !x.startsWith('-')).map((x) => x.replace(/^\+/, '').split(':').slice(1).join(':')); return dsts.some(isReplaceRef) ? NO_REPLACE : dsts.some(isRemoteRef) ? NO_FETCH_DST : null; }],
    [/^git\s+config\b/, (a) => {
      const pos = a.filter((x, i) => !x.startsWith('-') && !/^(--file|-f|--blob)$/.test(a[i - 1] ?? ''));
      if (a.some((x) => /^(-e|--edit)$/.test(x)) || pos[0] === 'edit') return NO_EDIT_CFG;
      const sections = a.some((x) => /^--(remove|rename)-section$/.test(x)) || ['remove-section', 'rename-section'].includes(pos[0]);
      if (sections && pos.some((x) => /^(core|sflow)$/i.test(x))) return NO_HOOKS_CFG;
      const writes = sections || a.some((x) => /^--(add|replace-all|unset|unset-all)$/.test(x)) || ['set', 'unset'].includes(pos[0]);
      const reads = a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list)$/.test(x)) || pos[0] === 'get';
      const hit = (re) => pos.findIndex((x) => re.test(x));
      const bad = (re, msg) => { const k = hit(re); return k >= 0 && (writes || (!reads && pos.length > k + 1)) ? msg : null; };
      return bad(/^remote\..+\.fetch$/i, NO_FETCH_CFG) ?? bad(DISCOVERY_KEY, NO_DISCOVERY_CFG) ?? bad(/^core\.hookspath$/i, NO_HOOKS_CFG) ?? bad(/^sflow\./i, NO_HOOKS_CFG) ?? driverConfigReason(raw);
    }],
    [/^gh\s+api\b.*(\s-X\s*(PUT|POST|PATCH|DELETE)|\s--method\s*(PUT|POST|PATCH|DELETE)|\s--input\b|\s-F\b|\s-f\b)/, 'write calls to the GitHub API are not allowed from an agent; use gh pr create/edit/comment'],
    [/^gh\s+(release|repo\s+delete|repo\s+archive|secret|variable|workflow\s+(run|enable|disable))\b/, 'releases, repo lifecycle, secrets, and workflow triggers are human actions'],
    [/^gh\s+repo\s+edit\b/, NO_REPO_EDIT],
    [/^(npm|pnpm|yarn|bun)\s+publish\b|^npm\s+(deprecate|unpublish)\b|^cargo\s+publish\b|^uv\s+publish\b|^twine\b/, 'publishing a package is a human action'],
    [/^gh\s+pr\s+merge\b|^gh\s+pr\s+close\b/, allowMerge === true ? null : unreadable ? NO_MERGE_UNREADABLE : 'merging or closing a PR is a human or Shipping-playbook decision; set allowMerge in .harness.json on the base branch on origin'],
  ];
  const args = raw.replace(/["']/g, '').split(/\s+/).slice(2); // quotes dropped so a quoted refspec cannot hide
  for (const [re, rule] of rules) {
    const why = typeof rule === 'function' ? rule(args) : rule;
    if (why && re.test(seg)) return why;
  }
  return null;
}

export function envReason(cmd) {
  // update-ref --stdin is denied outright in reason(), whatever its input.
  if (/core\.hookspath/i.test(cmd)) return 'overriding core.hooksPath disables the project hooks'; // i: git config keys are case-insensitive (core.hookspath, CORE.HOOKSPATH work in -c, --config-env, GIT_CONFIG_KEY_n and GIT_CONFIG_PARAMETERS)
  if (/(^|\s)-c\s*["']?remote\.[^\s=]+\.fetch\s*=|--config-env[=\s]+["']?remote\.[^\s=]+\.fetch\b|\bGIT_CONFIG_KEY_\d+=["']?remote\.[^\s=]+\.fetch\b/i.test(cmd)) return NO_FETCH_OVERRIDE;
  if (/(^|\s)-c\s*["']?(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.[^\s='"]+)["']?(\s*=|\s|$)|--config-env[=\s]+["']?(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.[^\s=]+)\s*=|\bGIT_CONFIG_KEY_\d+=["']?(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.\S+?)["']?(\s|$)/i.test(cmd)) return NO_DISCOVERY_CFG;
  if (DRIVER_TEXT.test(cmd) && !quotesAreData(cmd)) return NO_DIFF_DRIVER;
  const params = /\bGIT_CONFIG_PARAMETERS=("[^"]*"|'[^']*'|\S*)/.exec(cmd);
  if (params && FETCH_KEY.test(params[1])) return NO_FETCH_OVERRIDE;
  if (params && DISCOVERY_ENV.test(params[1])) return NO_DISCOVERY_CFG;
  if (params && DRIVER_PARAM.test(params[1]) && !quotesAreData(cmd)) return NO_DIFF_DRIVER;
  if (/\b(HUSKY|LEFTHOOK|SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG)=/.test(cmd)) return 'disabling commit hooks by environment is not allowed';
  const writes = gitWrites(cmd).map((w) => w.kind);
  if (writes.includes('config')) return 'writing a git config file directly can make git run commands (core.pager, core.sshCommand, aliases, filters); use `git config <key> <value>` instead';
  if (writes.includes('unhook') && !policyWriteReason(cmd)) return 'deleting or moving git hooks turns off the guards that run outside Claude; leave them in place and ask the user'; // SID-155; a policy-file write on the same line keeps its own (also denying) reason
  if (writes.includes('hooks')) return 'writing into a hooks directory installs code git runs automatically; ask the user, or use the harness hook setup';
  if (writes.length && segments(cmd).some((s) => /^git\b/.test(s))) return 'a write into .git/info or .git/modules is followed by a git command on the same line; git may run what was written; do the write on its own and review it';
  return null;
}

// SID-66: the policy files (lib.mjs POLICY_FILES) are not written from the shell either. Best-effort, no expansion: variables, indirect paths, scripts run from files and cd-then-relative writes are not seen.
// Runs on the WHOLE command, not on segments(): segments() splits inside quotes and heredoc bodies. This splitter is quote-aware, skips heredoc bodies, and drops `# comments`.
// Returns [{ w: words (quotes removed), r: redirect-output targets }] per simple command.
export function simpleCommands(s) {
  const cmds = []; let c = { w: [], r: [] }, cur = null, quoted = false, mode = null, hd = false;
  const pend = [];
  const word = () => {
    if (cur === null) return;
    if (mode === 'out') c.r.push(cur); else if (mode === 'in') { if (hd) pend.push(cur); } else c.w.push(cur);
    cur = null; quoted = false; mode = null; hd = false;
  };
  const sep = () => { word(); if (c.w.length || c.r.length) cmds.push(c); c = { w: [], r: [] }; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") { cur ??= ''; quoted = true; const j = s.indexOf("'", i + 1), e = j < 0 ? s.length : j; cur += s.slice(i + 1, e); i = e; }
    else if (ch === '"') { cur ??= ''; quoted = true; for (i++; i < s.length && s[i] !== '"'; i++) { if (s[i] === '\\' && '"\\$`'.includes(s[i + 1] ?? '')) i++; cur += s[i]; } }
    else if (ch === '\\') { cur ??= ''; quoted = true; if (s[++i] !== undefined && s[i] !== '\n') cur += s[i]; }
    else if (ch === '#' && cur === null) { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e - 1; }
    else if (ch === '\n' || ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '`' || (ch === '&' && s[i + 1] !== '>')) {
      sep();
      if (ch === '\n') while (pend.length) { const d = pend.shift(); let k = i + 1; for (;;) { const e = s.indexOf('\n', k), line = s.slice(k, e < 0 ? s.length : e); k = e < 0 ? s.length : e + 1; if (e < 0 || line.trim() === d) break; } i = k - 1; }
    }
    else if (ch === '>' || ch === '<' || ch === '&') {
      if (cur !== null && !quoted && /^\d+$/.test(cur)) cur = null; else word();
      const rw = ch === '<' && s[i + 1] === '>'; // <> opens the file for reading AND writing: an output
      if (ch === '&') i++; // &>
      if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') { hd = true; i++; if (s[i + 1] === '-') i++; } else if (ch === '<' && s[i + 1] === '<') i += 2; // << heredoc delimiter, <<< here-string
      else if (s[i + 1] === '>' || s[i + 1] === '|' || s[i + 1] === '&') i++; // >> >| >& <>
      mode = ch === '<' && !rw ? 'in' : 'out';
    }
    else if (/\s/.test(ch)) word();
    else cur = (cur ?? '') + ch;
  }
  sep();
  return cmds;
}

// Wrappers (WRAPPERS from lib.mjs, plus setsid and flock) are peeled until the real command shows. unwrap() works on a string, so words are re-quoted on the way in and unquoted on the way out.
const quote = (x) => { const [, k = '', v] = /^([A-Za-z_]\w*=)?([\s\S]*)$/.exec(x); return k + (v !== '' && /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`); };
const unquote = (t) => t.replace(/'([^']*)'|"([^"]*)"|\\([\s\S])/g, (_, a, b, c) => a ?? b ?? c);
const resplit = (str) => { const out = []; for (let [t, r] = take(str); t !== null; [t, r] = take(r)) out.push(unquote(t)); return out; };
// flock [opts] <lockfile|fd> <cmd...>  or  flock [opts] <lockfile> -c '<cmd>': options with a value (-w -E), the lock file, then the command (or the -c string, run like sh -c).
function flock(w) {
  let j = 1, str = null;
  for (; j < w.length && w[j].startsWith('-') && w[j] !== '-'; j++) {
    if (w[j] === '--') { j++; break; }
    if (/^-[a-zA-Z]*c$|^--command$/.test(w[j])) str = w[++j] ?? '';
    else if (/^-[a-zA-Z]*[wE]$|^--(wait|timeout|conflict-exit-code)$/.test(w[j])) j++;
  }
  j++; // the lock file or fd
  if (str === null && /^-[a-zA-Z]*c$|^--command$/.test(w[j] ?? '')) str = w[j + 1] ?? '';
  return str === null ? w.slice(j) : ['sh', '-c', str];
}
function peel(w) {
  for (;;) {
    let i = 0;
    while (i < w.length && /^[A-Za-z_]\w*=/.test(w[i])) i++;
    const b = base(w[i] ?? '');
    if (b === 'setsid') { i++; while (w[i]?.startsWith('-')) i++; w = w.slice(i); }
    else if (b === 'flock') w = flock(w.slice(i));
    else if (Object.hasOwn(WRAPPERS, b)) w = resplit(unwrap(b, w.slice(i + 1).map(quote).join(' ')));
    else return w.slice(i);
  }
}
const INTERP = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/;
const POLICY_NAME = /\.harness\.json|\.claude\/settings(\.local)?\.json|\.claude['"]?\s*,\s*['"]settings(\.local)?\.json/i;
const POLICY_SRC = POLICY_NAME.source;
// Best-effort list of write/delete calls in an inline script (node/python/ruby/perl/deno/bun). Only calls that always write or delete: reads (readFile, open(f), open(f,'r'), json.load, read_text, File.open(f), print, JSON.parse) never match.
const WRITE_CALL = /writeFile|appendFile|writeSync|createWriteStream|rename|unlink|\brmSync|\brm\b|symlink|\blink\(|truncate|write_text|write_bytes|File\.(write|binwrite|delete|rename)|FileUtils|IO\.write|os\.(remove|rename|replace)|shutil\.(move|rmtree)|Deno\.(write|remove|rename|truncate)|Bun\.write|,\s*['"](?:[wax]|r\+)[bt]?\+?['"]|\b(?:mode|flags?)\s*[:=]\s*['"](?:[wax]|r\+)|['"]\s*\+?>>?/;
// Copies write only their destination (the text after the first comma), so copying FROM a policy file is a read.
const COPY_CALL = new RegExp(String.raw`(?:copyFile\w*|\bcpSync|\bfs\.cp|shutil\.copy\w*)\s*\([^,]*,[\s\S]*?(?:${POLICY_SRC})`, 'i');
const scriptWrites = (text) => WRITE_CALL.test(text) || COPY_CALL.test(text);
const P = (x) => isPolicyPath(x) || policyGlobHit(x);

// An inline script (node -e, python -c, ruby -e, perl -e, deno eval) is denied when a policy path is the TARGET of a write call, or a variable holding a policy path is. Reading a policy file and writing elsewhere is fine.
// A small quote- and paren-aware scanner finds the calls and splits their arguments. When it can't parse reliably (unterminated string or call), the old rule applies: a policy name plus any write call denies.
const AT = (x) => x?.[0]?.replace(/['"\s,]+/, '/');
const closeQuote = (t, i) => { for (let k = i + 1; k < t.length; k++) { if (t[k] === '\\') k++; else if (t[k] === t[i]) return k; } return -1; };
function parseScript(t) { // masked: same text with string bodies blanked (so names inside strings never match); strs: the string literals
  let masked = '', strs = [];
  for (let i = 0; i < t.length; i++) {
    if ('\'"`'.includes(t[i])) { const e = closeQuote(t, i); if (e < 0) return null; strs.push(t.slice(i + 1, e)); masked += t[i] + t.slice(i + 1, e).replace(/[^\n]/g, ' ') + t[i]; i = e; } else masked += t[i];
  }
  return { masked, strs };
}
// Split the arguments of the call whose '(' is at open, or (no parens, perl/ruby) the rest of the statement from open. Returns { args, end } or null.
function callArgs(t, open, parens) {
  const args = []; let depth = parens ? 0 : 1, start = open + (parens ? 1 : 0), stop = t.length;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if ('\'"`'.includes(c)) { i = closeQuote(t, i); if (i < 0) return null; }
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (--depth === 0) { args.push(t.slice(start, i)); return { args, end: i + 1 }; } if (depth < 0) { stop = i; break; } }
    else if (c === ',' && depth === 1) { args.push(t.slice(start, i)); start = i + 1; }
    else if (!parens && depth === 1 && (c === ';' || c === '\n')) { stop = i; break; }
  }
  if (parens) return null;
  args.push(t.slice(start, stop)); return { args, end: stop };
}
// The expression before the '.' at dot: `Path('x')` or `pathlib.Path(p)` or `p`.
function receiver(masked, t, dot) {
  let e = dot, k = dot;
  if (masked[k - 1] === ')') { let d = 0; for (k--; k >= 0; k--) { if (masked[k] === ')') d++; else if (masked[k] === '(' && --d === 0) break; } if (k < 0) return t.slice(0, e); }
  while (k > 0 && /[\w$.]/.test(masked[k - 1])) k--;
  return t.slice(k, e);
}
const CALLS = [
  ['first', String.raw`writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|rm|rmSync|rmdir|rmdirSync|rimraf|rimrafSync|unlink|unlinkSync|rmtree|remove|removeSync|removedirs|rm_f|rm_r|rm_rf|remove_file|remove_entry|touch|File\.(?:write|binwrite|delete|truncate|unlink)|IO\.(?:write|binwrite)|Bun\.write|Deno\.(?:writeTextFile|writeFile|writeTextFileSync|writeFileSync|create|createSync)`],
  ['recv', 'write_text|write_bytes'],
  ['both', String.raw`rename|renameSync|renames|symlink|symlinkSync|link|linkSync|symlink_to|link_to|hardlink_to|shutil\.move|os\.replace|FileUtils\.(?:mv|ln|ln_s|ln_sf|move)|mv|mv_f|move_file`],
  ['dest', String.raw`copyFile|copyFileSync|cp|cpSync|shutil\.(?:copy|copy2|copyfile|copytree)|FileUtils\.(?:cp|cp_r|copy|copy_file|install)|copy_file`],
  ['open', String.raw`open|openSync|File\.new`],
  ['exec', String.raw`system|popen|exec|execSync|execFile|execFileSync|spawn|spawnSync|run|call|check_call|check_output|Popen|execv|execvp|exec_command`],
].map(([mode, src]) => [mode, new RegExp(String.raw`(?<![\w$])(?:${src})(?![\w$])`, 'g')]);
const WRITE_MODE = /^\s*(?:[rwabxt+]*[wax+][rwabxt+]*|\+?>>?|\+<|\|.*)\s*$/; // 'w' 'a+' 'wb' 'r+' and perl > >> +<
const READ_FLAG = /O_RDONLY|^\s*(?:'r'|"r"|'rb'|"rb"|'rt'|"rt")\s*$/;

function inlineWrite(text, depth, out) {
  const old = () => (scriptWrites(text) ? AT(POLICY_NAME.exec(text)) : null);
  const ps = parseScript(text);
  if (!ps) return old();
  const { masked, strs } = ps;
  const taint = new Map(); // variable -> policy path it was assigned
  const idents = (x) => parseScript(x)?.masked.match(/\$?[A-Za-z_]\w*/g) ?? [];
  for (let pass = 0; pass < 2; pass++) {
    for (const m of masked.matchAll(/(?<![\w$.])(\$?[A-Za-z_]\w*)\s*:?=(?![=>~])/g)) {
      const c = callArgs(text, m.index + m[0].length, false); // up to ; or newline: a declarator list `a=1, p=x` is cut at its comma below
      let rhs = c ? text.slice(m.index + m[0].length, c.end) : '';
      for (let d = 0, k = 0; k < rhs.length; k++) { if ('\'"`'.includes(rhs[k])) { const e = closeQuote(rhs, k); if (e < 0) break; k = e; } else if ('([{'.includes(rhs[k])) d++; else if (')]}'.includes(rhs[k])) { if (--d < 0) { rhs = rhs.slice(0, k); break; } } else if (rhs[k] === ',' && d === 0) { rhs = rhs.slice(0, k); break; } }
      const hit = AT(POLICY_NAME.exec(rhs)) ?? idents(rhs).map((v) => taint.get(v)).find(Boolean);
      if (hit) taint.set(m[1], hit);
    }
  }
  const argish = /argv|ARGV|environ|process\.env|getenv|\bENV\b/;
  const target = (x) => { // the policy path this target expression names (literal, or a variable assigned one), else null
    const lit = AT(POLICY_NAME.exec(x)) ?? idents(x).map((v) => taint.get(v)).find(Boolean);
    return lit ?? (argish.test(x) && POLICY_NAME.test(text) ? AT(POLICY_NAME.exec(text)) : null);
  };
  let hit = null;
  for (const [mode, re] of CALLS) {
    for (const m of masked.matchAll(re)) {
      const at = m.index + m[0].length, after = /^\s*/.exec(masked.slice(at))[0].length, paren = masked[at + after] === '(';
      if (!paren && !(after > 0 && /[\w$"'\[@\\]/.test(masked[at + after] ?? ''))) continue; // a name that is not called
      const call = callArgs(text, at + after, paren);
      const dot = masked[m.index - 1] === '.' ? m.index - 1 : -1, recv = dot >= 0 ? receiver(masked, text, dot) : '';
      if (!call) { if (POLICY_NAME.test(text.slice(m.index))) hit ??= AT(POLICY_NAME.exec(text.slice(m.index))); continue; }
      const a = call.args;
      if (mode === 'first') hit ??= target(a[0] ?? '') ?? target(recv);
      else if (mode === 'recv') hit ??= target(recv);
      else if (mode === 'both') hit ??= a.map(target).find(Boolean) ?? target(recv);
      else if (mode === 'dest') hit ??= a.length > 1 ? target(a[1]) : a.map(target).find(Boolean);
      else if (mode === 'open') {
        const mv = (a[1] ?? '').replace(/^\s*(?:mode|flags?)\s*[:=]\s*/, ''), lit = /^\s*(["'])(.*)\1\s*$/s.exec(mv);
        const unknown = mv.trim() !== '' && !lit && !READ_FLAG.test(mv);
        const writes = lit ? WRITE_MODE.test(lit[2]) : unknown;
        if (writes) hit ??= target(a[0] ?? '') ?? (/^\s*(?:\+?>|\+<)/.test(lit?.[2] ?? '') ? a.slice(1).map(target).find(Boolean) : null) ?? target(recv);
        else if (!lit && a[0] && /^\s*(["'])[wax+]/.test(a[0]) && recv) hit ??= target(recv); // Path('x').open('w')
      } else if (mode === 'exec') {
        const sh = parseScript(call.args.join(' '))?.strs.join(' ');
        if (sh && POLICY_NAME.test(sh)) { if (depth < 3) { const o = scan(sh, depth + 1, { hit: null, through: [], into: out.into, cds: [], links: out.links, modes: out.modes }); hit ??= o.hit; } else hit ??= old(); }
      }
    }
  }
  // Strings that name a policy file are also read as shell (cmd = "rm .harness.json"; os.system(cmd)): only a real write there denies; print('edit .claude/settings.json by hand') does not.
  for (const x of strs) if (!hit && POLICY_NAME.test(x)) { if (depth >= 3) return old(); hit = scan(x, depth + 1, { hit: null, through: [], into: out.into, cds: [], links: out.links, modes: out.modes }).hit; }
  return hit;
}
const base = (x) => x.replace(/\/+$/, '').split('/').pop();
// A whole .claude directory (any parent, ~ and $HOME too). Replacing, moving or deleting it replaces settings.json inside it, so it reports the settings hit.
const CLAUDE_DIR_HIT = '.claude/settings.json';
const isClaudeDir = (x) => base(x.replace(/(\/\.)+\/?$/, '')).toLowerCase() === '.claude';
const recursive = (flags) => flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f) && !f.startsWith('--'));
const isDirish = (x) => /(^|\/)\.{1,2}\/?$|\/$/.test(x);

// Split args into flags and positionals; -t/--target-directory VALUE (cp, mv, ln, install) is returned as t.
function split(args, targetDir) {
  const flags = [], pos = []; let t = null, rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest || !a.startsWith('-') || a === '-') pos.push(a);
    else if (a === '--') rest = true;
    else if (targetDir && (a === '-t' || a === '--target-directory')) t = args[++i] ?? null;
    else if (targetDir && a.startsWith('--target-directory=')) t = a.slice(19);
    else flags.push(a);
  }
  return { flags, pos, t };
}

// One simple command: returns { hit: offending policy path | null, through: paths written through (symlink check) }.
// Every path is relative to the cwd, which `cd`/`pushd` earlier in the command may have moved: a path is tested as written and joined onto those cds (an absolute or ~ cd resets; cds with $ are unknown and skipped).
const cdDir = (cds) => { let cur = ''; for (const c of cds) if (!c.includes('$')) cur = /^[/~]/.test(c) ? c : posix.join(cur || '.', c); return cur; };
function oneCommand({ w, r }, depth, out) {
  const here = cdDir(out.cds);
  const joined = (x) => (here && !/^[/~]/.test(x) ? posix.join(here, x) : x);
  const policy = (x) => (P(x) ? x : P(joined(x)) ? joined(x) : null);
  const written = (x) => { out.through.push(x); if (joined(x) !== x) out.through.push(joined(x)); const h = policy(x); if (h) out.hit ??= h; };
  for (const x of r) written(x);
  w = peel(w);
  const name = base(w[0] ?? ''); let args = w.slice(1);
  if (!name) return;
  const hitAny = (xs) => { for (const x of xs) { const h = policy(x); if (h) out.hit ??= h; } };
  if (/^(sh|bash|zsh|dash|ksh)$/.test(name)) { const k = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)); if (k >= 0 && args[k + 1] && depth < 3) scan(args[k + 1], depth + 1, out); return; }
  if (name === 'cd' || name === 'pushd') { const d = args.find((x) => x !== '--' && !(x.startsWith('-') && x.length > 1)); if (d && d !== '-') out.cds.push(d); return; }
  if (name === 'eval') { if (depth < 3) scan(args.join(' '), depth + 1, out); return; }
  if (name === 'git') {
    while (args[0]?.startsWith('-')) args = args.slice(/^-(C|c)$|^--(git-dir|work-tree|exec-path)$/.test(args[0]) ? 2 : 1);
    const sub = args[0], { flags, pos } = split(args.slice(1));
    const dirHit = () => { if (pos.some(isClaudeDir)) out.hit ??= CLAUDE_DIR_HIT; };
    if (sub === 'checkout') { hitAny(pos); dirHit(); }
    else if (sub === 'restore') { if (!(flags.some((f) => f === '--staged' || f === '-S') && !flags.some((f) => f === '--worktree' || f === '-W'))) { hitAny(pos); dirHit(); } }
    else if (sub === 'mv') { hitAny(pos); dirHit(); }
    else if (sub === 'rm') { if (!flags.includes('--cached')) { hitAny(pos); dirHit(); } }
    // `git log --output=F` / `git diff --output F` write F (main's writesFile scan sees the same two spellings)
    args.slice(1).forEach((a, k) => { if (a === '--output' && args[k + 2]) written(args[k + 2]); else if (a.startsWith('--output=')) written(a.slice(9)); });
    return;
  }
  if (INTERP.test(name)) {
    const text = args.join(' '), inline = args.some((a, k) => (k === 0 && name === 'deno' && a === 'eval') || /^(--eval|--print|-[a-zA-Z]*[ecEp])$/.test(a));
    if (inline && POLICY_NAME.test(text)) { const h = inlineWrite(text, depth, out); if (h) out.hit ??= h; }
    if (/^(perl|ruby)$/.test(name) && args.some((a) => /^-(?![MIm])[A-Za-z]*i\S*$/.test(a))) { const e = args.findIndex((a) => /^-[A-Za-z]*[eE]$/.test(a)); args.filter((a, k) => !a.startsWith('-') && k !== e + 1).forEach(written); }
    return;
  }
  // sort -o F / --output=F and uniq IN OUT write a file (main's sortOut/uniqOut find the operand)
  if (name === 'sort') { sortOut(args).forEach(written); return; }
  if (name === 'uniq') { uniqOut(args).forEach(written); return; }
  const { flags, pos, t } = split(args, /^(cp|mv|ln|install)$/.test(name));
  if (name === 'tee') { pos.forEach(written); return; }
  if (/^(cp|install|rsync|ln|mv)$/.test(name)) {
    const dest = t ?? pos.at(-1), srcs = t ? pos : pos.slice(0, -1);
    if (dest === undefined) { if (name === 'ln') hitAny(pos); return; }
    if (name !== 'mv') out.through.push(dest);
    if (name === 'ln') { const sym = flags.some((f) => f === '--symbolic' || /^-[a-zA-Z]*s/.test(f) && !f.startsWith('--')); for (const x of srcs) { out.links.push(joined(x)); if (sym && !/^[/~]/.test(x)) out.links.push(posix.join(posix.dirname(joined(dest)), x), posix.join(joined(dest), x)); } } // SID-162: pre-bash resolves both ends against the hooks and git config files
    const pol = srcs.map(base).filter((b) => /^(\.harness\.json|settings(\.local)?\.json)$/i.test(b));
    if (pol.length) out.into.push({ dest, names: pol, dir: !!t || isDirish(dest), cds: [...out.cds] }); // pre-bash resolves dir/<name> against the cwd (and any cd seen so far) and denies only a landing on the root .harness.json or a .claude/settings*.json
    if (policy(dest)) out.hit ??= policy(dest);
    else if (base(dest) === '.claude' && srcs.some((x) => /^settings(\.local)?\.json$/i.test(base(x)))) out.hit ??= '.claude/settings.json';
    if (name === 'ln' || name === 'mv') hitAny(pos);
    if (name === 'mv' ? [...srcs, dest].some(isClaudeDir) : isClaudeDir(dest) && srcs.some(isClaudeDir)) out.hit ??= CLAUDE_DIR_HIT;
    return;
  }
  if (name === 'chmod' || name === 'chown' || name === 'chgrp') { out.modes.push(...pos.slice(flags.some((f) => f.startsWith('--reference')) ? 0 : 1).map(joined)); return; } // SID-162: pre-bash resolves these (a symlink into a hooks dir: `chmod +x pc`)
  if (/^(rm|unlink|truncate|shred)$/.test(name)) { if (name !== 'rm' && name !== 'unlink') out.through.push(...pos); hitAny(pos); if (name === 'rm' && recursive(flags) && pos.some(isClaudeDir)) out.hit ??= CLAUDE_DIR_HIT; return; }
  if (name === 'dd') { for (const a of args) if (a.startsWith('of=')) written(a.slice(3)); return; }
  if (name === 'sed') { if (flags.some((f) => /^-[A-Za-z]*i|^--in-place/.test(f))) { const sc = flags.filter((f) => /^-[A-Za-z]*[ef]$|^--(expression|file)$/.test(f)).length; pos.slice(sc || flags.some((f) => /^-[A-Za-z]*[ef]\S|^--(expression|file)=/.test(f)) ? sc : 1).forEach(written); } return; } // script words (the first positional, or one per -e/-f) are not files
  if (/^(ed|ex|vim|vi|nano|emacs)$/.test(name)) hitAny(pos);
}

function scan(text, depth, out) { for (const c of simpleCommands(text)) oneCommand(c, depth, out); return out; }
// { hit, through }: hit is the first policy path the command writes, creates, replaces, moves, links or deletes; through lists paths written through (symlink check in pre-bash), into lists copies of a policy-named file to a destination that may be a directory (resolved in pre-bash; copying FROM a policy file is a read), cds the `cd` arguments seen so far.
export const analyzeWrites = (cmd) => scan(String(cmd), 0, { hit: null, through: [], into: [], cds: [], links: [], modes: [] });
export const policyWriteReason = (cmd) => { const { hit } = analyzeWrites(cmd); return hit ? policyDeny(hit) : null; };

// SID-191: expansions the guard can't see through fail closed where they could change a guarded command. reason() reads literal text, so
// `$X`, `${X}`, `$(..)` and backticks are probed: each expansion in a git or gh argument is replaced by risky values (and, unquoted, by
// several words, since word splitting can add them); if any probe makes reason() deny, the command is denied. Values of message-like options
// (-m "$MSG", --body "$(cat ..)") are data and are not probed. Variables assigned earlier on the same line are substituted first.
const EXPANDS = /\$[\w{(@*#?!$-]|`/;
const hasExp = (t) => EXPANDS.test(t.replace(/'[^']*'/g, '').replace(/\\[\s\S]/g, ''));
const VALUE_OPT = /^(-m|--message|-F|--file|-t|--title|-b|--body|--body-file|-T|--template|--grep|--author|--committer|--format|--pretty|--date|--since|--until|--after|--before|-S|-G|--jq|-q|--label|-l|--assignee|-a|--reviewer|-r|--milestone|--project|-o|--output|--search|--state|--limit|-L|--json|--trailer|--reason|--subject|--description|--notes|-n|--name)$/;
const VALUE_OPT_EQ = /^(--message|--file|--title|--body|--body-file|--template|--grep|--author|--committer|--format|--pretty|--date|--since|--until|--after|--before|--jq|--label|--assignee|--reviewer|--milestone|--project|--output|--search|--json|--trailer|--subject|--description|--notes)=/;
// value options whose flag letter is also a guarded short flag elsewhere (-n, -f, -t, -b, -r, -a, -l, -o, -q): only data for these subcommands
const VALUE_OPT_SUBS = /^(git (commit|tag|log|show|shortlog|notes|grep|blame|stash push|stash save|format-patch|rev-list|for-each-ref)|gh (pr (create|edit|comment|review|list|view)|issue|search|run (list|view)|repo view|api))\b/;
const PROBES = ['--hard', '--merge', '--force', '-f', '-fd', '-xdf', '-D', '--no-verify', '-n', '--stdin', '-d', '--delete', '--mirror', '--tags', '.', '--discard-changes',
  '-XPOST', '-X', '-f=x', '--input', '--method=DELETE', 'merge', 'close', 'delete', 'clear', 'drop', 'set', 'main', 'master', '+main', 'HEAD:main', ':main', 'refs/remotes/origin/main',
  'x:refs/remotes/origin/main', 'refs/replace/x', 'core.bare', 'include.path', 'remote.origin.fetch', '--worktree', '-e'];
const GIT_SUBS = ['push', 'reset', 'clean', 'branch', 'stash', 'commit', 'merge', 'rebase', 'update-ref', 'replace', 'filter-branch', 'fast-import', 'config', 'symbolic-ref', 'checkout', 'restore', 'switch', 'fetch', 'remote', 'gc', 'reflog'];
const GH_SUBS = ['pr', 'api', 'release', 'repo', 'secret', 'variable', 'workflow'];
const toks = (s) => { const w = []; for (let [t, r] = take(s); t !== null; [t, r] = take(r)) w.push(t); return w; };
// Candidate replacements for one expanding word: the probe as one word (respecting the literal text around the expansion), and, when the
// expansion is unquoted, the literal prefix followed by the probe as a separate word.
function variants(word, probe) {
  const dq = /^"[\s\S]*"$/.test(word);
  const body = dq ? word.slice(1, -1) : word;
  const m = /\$\{[^}]*\}|\$\([\s\S]*\)|`[^`]*`|\$[\w@*#?!$-]+/.exec(body);
  if (!m) return [];
  const pre = canon(body.slice(0, m.index)).text.replace(/^'|'$/g, ''), post = canon(body.slice(m.index + m[0].length)).text.replace(/^'|'$/g, '');
  const out = [];
  if (probe.startsWith(pre) && probe.endsWith(post) && probe.length >= pre.length + post.length) out.push([probe]);
  if (!dq) { if (pre && !post) out.push([pre, probe]); if (post && !pre) out.push([probe, post]); if (pre && post) out.push([pre, probe, post]); }
  return out;
}
export function expansionReason(seg, cfg, branch, vars = new Map()) {
  if (!hasExp(seg)) return null;
  // 1. variables assigned earlier on this line: substitute their values and check again
  const sub = seg.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, k) => (vars.has(k) ? vars.get(k) : m));
  if (sub !== seg) {
    for (const s of segments(sub)) { const c = normalize(canon(s).text); const why = reason(c, cfg, branch) ?? reason(s, cfg, branch); if (why) return `${why} (after substituting the variables set earlier in this command)`; }
  }
  // a command substitution is one expansion, whatever spaces it holds (its own commands are segments of their own)
  const w = toks(seg.replace(/\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|`[^`]*`/g, (m) => (/\s/.test(m) ? '$__subst' : m)));
  if (!w.length) return null;
  const say = (what) => `an expansion (${what}) the guard can't read could turn this into a denied command; write the value out literally (or quote a message argument)`;
  // 2. the command word itself is an expansion: try each guarded program in its place (not twine: it is denied whatever follows)
  let words = w, cands;
  if (hasExp(w[0])) cands = ['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'uv'].map((e) => [e, ...w.slice(1)]);
  else if (/^(git|gh)$/.test(w[0])) cands = [w];
  else if (/^(npm|pnpm|yarn|bun|npx)$/.test(canon(w[0]).text) && w.slice(1).some(hasExp)) return say(w.slice(1).find(hasExp)); // every word, not just the subcommand: `npm --silent ${X:-publish}` // SID-191 review B5: `npm ${X:-publish}`, `npm "$(printf %s publish)"`
  else return null;
  // the rest of the line names a guarded subcommand (`$CMD push`, `$GH pr merge 1`, `$X publish`), or is itself an expansion: a guarded program
  // could be in that variable, so it fails closed. `$EDITOR notes.md`, `$PYTHON x.py`, `$CMD status` stay allowed.
  if (hasExp(w[0]) && w[1] !== undefined && (hasExp(w[1]) || [...GIT_SUBS, ...GH_SUBS, 'publish', 'unpublish', 'deprecate', 'filter-repo'].includes(canon(w[1]).text))) return say(w[0]);
  for (words of cands) {
    const exe = words[0];
    if (hasExp(w[0])) { const c = normalize(canon(words.join(' ')).text); if (reason(c, cfg, branch)) return say(w[0]); }
    // 3. an expanded subcommand: git $SUB, gh $X, gh pr $Y
    if (words[1] && hasExp(words[1]) && (exe === 'git' || exe === 'gh')) return say(words[1]);
    if (exe === 'gh' && words[2] && hasExp(words[2]) && /^(pr|repo|release|secret|variable|workflow)$/.test(canon(words[1]).text)) return say(words[2]);
    if (exe !== 'git' && exe !== 'gh') continue;
    const head = canon(words.slice(0, 3).join(' ')).text;
    const dataOpts = VALUE_OPT_SUBS.test(head);
    // 4. each expanding argument, probed
    for (let k = 2; k < words.length; k++) {
      const t = words[k];
      if (!hasExp(t)) continue;
      const prev = canon(words[k - 1]).text;
      if (dataOpts && (VALUE_OPT.test(prev) || VALUE_OPT_EQ.test(canon(t.split('=')[0]).text + '='))) continue;
      // a new branch's name: one double-quoted word can only be the name (unquoted, word splitting could add a pathspec such as `.`)
      if (/^git (checkout|switch)\b/.test(head) && /^(-b|-B|-c|-C|--orphan|--create|--force-create)$/.test(prev) && /^"[^"]*"$/.test(t)) continue;
      for (const probe of [...PROBES, ...(cfg.protectedBranches ?? [])]) {
        for (const v of variants(t, probe)) {
          const trial = [...words.slice(0, k).map((x, i) => (i > 1 && hasExp(x) ? 'x' : x)), ...v, ...words.slice(k + 1).map((x) => (hasExp(x) ? 'x' : x))];
          const c = normalize(canon(trial.join(' ')).text);
          if (reason(c, cfg, branch)) return say(t);
        }
      }
    }
  }
  return null;
}

// SID-191: what this line assigns (NAME=value as a command of its own, or export NAME=value), so expansionReason can substitute it.
export function assignments(cmd) {
  const vars = new Map();
  for (const { w } of simpleCommands(cmd)) {
    const words = w[0] === 'export' || w[0] === 'local' || w[0] === 'declare' || w[0] === 'readonly' ? w.slice(1) : w;
    for (const x of words) { const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(x); if (!m) break; vars.set(m[1], vars.has(m[1]) ? `${vars.get(m[1])}` : m[2]); }
  }
  return vars;
}

// SID-191: a git -c / --config-env value, or a GIT_CONFIG_* assignment, built from an expansion can set core.hooksPath, include.path or
// any other key the text checks can't see, so it is denied. eval of a variable runs text the guard never sees: denied too.
export function hiddenConfigReason(cmd) {
  for (const { w } of simpleCommands(cmd)) {
    for (const x of w) if (/^GIT_CONFIG(_\w+)?=/.test(x) && hasExp(x.replace(/^[^=]*=/, ''))) return 'a GIT_CONFIG_* value built from an expansion could set any git config key (core.hooksPath, include.path); write it out literally';
    let i = 0;
    while (i < w.length && /^[A-Za-z_]\w*=/.test(w[i])) i++;
    const b = base(w[i] ?? '');
    if (b === 'eval' && w.slice(i + 1).some((x) => /\$[\w{@*#?!-]/.test(x.replace(/\$\([\s\S]*\)/g, '')))) return 'eval of a variable runs text the guard never sees; run the command directly';
    if (b !== 'git') continue;
    for (let j = i + 1; j < w.length; j++) {
      const x = w[j];
      if (!x.startsWith('-')) break;
      const val = /^(-c|--config-env)$/.test(x) ? w[++j] ?? '' : /^(-c|--config-env=)/.test(x) ? x.replace(/^(-c|--config-env=)/, '') : null;
      if (val !== null && hasExp(val)) return 'a git -c / --config-env value built from an expansion could set any key (core.hooksPath, include.path); write it out literally';
      if (/^(-C|--git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--exec-path)$/.test(x)) j++;
    }
  }
  return null;
}

// SID-243: a per-command override of a driver key (git -c, --config-env, GIT_CONFIG_KEY_n, GIT_CONFIG_PARAMETERS). normalize() drops git's global options and VAR=x prefixes, so this reads every piece as written, each with its own quoting resolved: the line's, a $( ), a heredoc or text fed to a shell.
const GIT_GLOBAL_VALUE = /^(-C|--git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--exec-path)$/;
const driverOverride = (v) => DRIVER_KEY.test(v) || (v.includes('=') && (DRIVER_KEY.test(v.slice(0, v.indexOf('='))) || DRIVER_KEY.test(v.slice(0, v.lastIndexOf('='))))); // -c cuts at the first =, --config-env at the last
function driverOverrideReason(cmd) {
  for (const t of new Set([cmd, ...rawSegments(cmd)])) for (const { w } of simpleCommands(canon(t).text)) {
    for (const x of w) {
      const key = /^GIT_CONFIG_KEY_\d+=([\s\S]*)$/.exec(x)?.[1];
      if ((key !== undefined && DRIVER_KEY.test(key)) || (x.startsWith('GIT_CONFIG_PARAMETERS=') && DRIVER_PARAM.test(x))) return NO_DIFF_DRIVER;
    }
    const c = peel(w.slice(w.findIndex((x) => !SKIP_HEAD.has(x))));
    if (base(c[0] ?? '') !== 'git') continue;
    for (let j = 1; j < c.length && c[j].startsWith('-'); j++) {
      const x = c[j];
      const val = x === '-c' || x === '--config-env' ? c[++j] ?? '' : x.startsWith('--config-env=') ? x.slice(13) : null;
      if (val !== null && driverOverride(val)) return NO_DIFF_DRIVER;
      if (GIT_GLOBAL_VALUE.test(x)) j++;
    }
  }
  return null;
}
// SID-243: a command that names the file and isn't known to only read it. sed (w), awk (>), interpreters, editors, curl -o and unknown commands could write it; the write scan already reads the redirects, tee, cp, dd, sort -o and git --output of these.
const ATTR_READERS = new Set(['cat', 'grep', 'rg', 'head', 'tail', 'wc', 'ls', 'stat', 'file', 'test', '[', '[[', 'diff', 'cmp', 'less', 'more', 'echo', 'printf', 'cut', 'tr', 'sort', 'uniq', 'cp', 'dd', 'md5sum', 'sha1sum', 'sha256sum', 'git', 'gh', 'cd', 'pwd', 'true', 'false', ':', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'eval']); // a shell's script is a piece of its own
const ATTR_MENTION = /\.git\/(?:modules\/.+\/|worktrees\/[^\/]+\/)?info\/attributes(?![\w.-])/i;
function attrMentionReason(cmd) {
  for (const t of new Set([cmd, ...rawSegments(cmd)])) {
    if (gitWrites(t).some((x) => x.kind === 'attributes')) return NO_INFO_ATTRIBUTES;
    for (const { w } of simpleCommands(canon(t).text)) {
      const c = peel(w.slice(w.findIndex((x) => !SKIP_HEAD.has(x))));
      if (!ATTR_READERS.has(base(c[0] ?? '')) && w.some((x) => ATTR_MENTION.test(posix.normalize(x)))) return NO_INFO_ATTRIBUTES;
    }
  }
  return null;
}

// SID-191: the whole-line checks, on the command as written and with its quoting resolved. A quote, $( ) or backtick that never closes
// can't be read, so it fails closed.
export const NO_OPEN = "a quote, $( ) or backtick in this command is never closed, so the guard can't tell what runs; close it";
export function lineReason(cmd) {
  const C = canon(cmd);
  if (C.open) return NO_OPEN;
  return [...new Set([cmd, C.text])].map(envReason).find(Boolean) ?? hiddenConfigReason(cmd) ?? driverOverrideReason(cmd) ?? attrMentionReason(cmd);
}
// SID-191 review B1/B5: text another shell runs, with its quoting resolved the way that shell receives it. `bash -c 'P' a b` runs P with $0=a
// $1=b; `eval A B` runs "A B"; a function defined on the line whose body uses its arguments (`p(){ "$@"; }`) runs its body with the call's
// arguments. Positional parameters are substituted (each "$@" argument quoted on its own), so `bash -c 'eval "$1"' _ 'gh pr merge 1'` and
// `p gh pr merge 1` are read as the commands they run. Nesting past PAYLOAD_DEPTH fails closed.
export const PAYLOAD_DEPTH = 8;
const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const POS = /"\$(@|\*|\d|\{\d+\})"|\$(@|\*|\d|\{\d+\})/g;
const positional = (body, args) => body.replace(POS, (m, q, u) => {
  const k = (q ?? u).replace(/[{}]/g, '');
  if (k === '@') return q ? args.slice(1).map(sq).join(' ') : args.slice(1).join(' ');
  if (k === '*') return q ? sq(args.slice(1).join(' ')) : args.slice(1).join(' ');
  const v = args[+k] ?? '';
  return q ? sq(v) : v;
});
// SID-191 re-review (opus 2): which text of a -c payload can hold a positional parameter. Single-quoted text is normally still code to the shell that reads it
// (`trap '${1#}' EXIT`, `PS4='$(${1#})'`, `x@P`, `mapfile -C`, `alias`), so the payload is judged on its raw text, as at b2b5fd7, EXCEPT for the single-quoted words
// (and `\$` inside double quotes) of a plain awk/gawk/sed/cut/grep/jq command: their program text is data, and a shell they start has no positional parameters.
// The scanner reads only plain quoting; anything else (a backslash outside "..", $( ), a backtick, $'..', < > ( ) { }, a comment, an unclosed quote) returns the raw text.
const DATA_PROGRAMS = new Set(['awk', 'gawk', 'sed', 'cut', 'grep', 'jq']);
// Every command of the payload must be a data program or one of these plain commands, or the payload stays raw: `alias awk=eval`, `shopt`, `hash`, `enable`, `set` ... can turn a data program's head into code.
const PLAIN_PAYLOAD_HEADS = new Set(['echo', 'printf', 'cat', 'ls', 'head', 'tail', 'sort', 'uniq', 'wc', 'tr', 'true', 'false', 'cd', 'pwd', 'git', 'gh']);
export function positionalView(p) {
  const cmds = []; let raw = '', view = '', words = [], w = null;
  const endWord = () => { if (w) { words.push(w); w = null; } };
  const endCmd = () => { endWord(); if (words.length) cmds.push({ raw, view, data: words[0].plain && DATA_PROGRAMS.has(words[0].text), plain: words[0].plain && PLAIN_PAYLOAD_HEADS.has(words[0].text) }); raw = ''; view = ''; words = []; };
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "'") {
      const e = p.indexOf("'", i + 1); if (e < 0) return p;
      w ??= { text: '', plain: true }; w.plain = false; w.text += p.slice(i + 1, e); raw += p.slice(i, e + 1); view += ' '; i = e;
    } else if (c === '"') {
      w ??= { text: '', plain: true }; w.plain = false; raw += c; view += c;
      for (i++; i < p.length && p[i] !== '"'; i++) {
        const d = p[i];
        if (d === '`' || (d === '$' && p[i + 1] === '(')) return p;
        if (d === '\\') { if (p[i + 1] !== '$') return p; raw += '\\$'; i++; continue; } // `\$` in "..": a literal dollar, dropped from the view
        raw += d; view += d; w.text += d;
      }
      if (i >= p.length) return p;
      raw += '"'; view += '"';
    } else if (c === '\\' || c === '`' || c === '<' || c === '>' || c === '(' || c === ')' || c === '{' || c === '}' || (c === '$' && (p[i + 1] === "'" || p[i + 1] === '(')) || (c === '#' && !w)) return p;
    else if (c === '\n' || c === ';' || c === '&' || c === '|') endCmd();
    else if (/\s/.test(c)) { endWord(); raw += c; view += c; }
    else { w ??= { text: '', plain: true }; w.text += c; raw += c; view += c; }
  }
  endCmd();
  if (!cmds.every((x) => x.data || x.plain)) return p;
  return cmds.map((x) => (x.data ? x.view : x.raw)).join('\n');
}
const SH_RUN = /^(?:sh|ash|bash|zsh|dash|ksh|mksh|fish)$/;
function functionDefs(cmd) {
  const defs = new Map();
  for (const t of new Set([cmd, canon(cmd).text])) for (const m of t.matchAll(/(?:^|[\s;&|(])(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*([{(])([\s\S]*?)[})](?=\s*(?:;|&|\||\n|$))|(?:^|[\s;&|(])function\s+([A-Za-z_][\w-]*)\s*\{([\s\S]*?)\}(?=\s*(?:;|&|\||\n|$))/g)) {
    const name = m[1] ?? m[4], body = m[3] ?? m[5];
    if (POS.test(body)) defs.set(name, body);
    POS.lastIndex = 0;
  }
  return defs;
}
// The scripts one segment hands to another shell: [{ text }]. simpleCommands gives each word's value as the shell passes it on.
function runsText(seg, defs) {
  const out = [];
  for (const { w: raw } of simpleCommands(seg)) {
    let i = 0; while (i < raw.length && /^[A-Za-z_]\w*=/.test(raw[i])) i++;
    let w = raw.slice(i);
    // wrappers (env, timeout, nice, ...) are already stripped: segments() normalizes each segment
    let b = base(w[0] ?? '');
    if (b === 'busybox') { w = w.slice(1); b = base(w[0] ?? ''); }
    if (b === 'eval' && w.length > 1) out.push(w.slice(1).join(' '));
    else if (SH_RUN.test(b)) {
      for (let k = 1; k < w.length; k++) {
        const o = w[k];
        if (!/^[-+]/.test(o)) break;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(o)) { let j = k + 1; while (j < w.length && /^[-+]/.test(w[j]) && w[j] !== '--') j += /^[-+][oO]$/.test(w[j]) ? 2 : 1; if (w[j] === '--') j++; if (w[j] !== undefined) { if (POSITIONAL.test(positionalView(w[j]))) out.positional = w[j]; out.push(positional(w[j], w.slice(j + 1))); } break; }
        if (/^[-+][oO]$/.test(o)) k++;
      }
    } else if (defs.has(w[0] ?? '')) out.push(positional(defs.get(w[0]), w));
  }
  return out;
}

// SID-191 review B3/B4: brace expansion and unquoted globs can build a guarded word (`gh pr {merge,1}`, `g{h,} pr merge 1`,
// `git reset --har? HEAD~1`, `git push origin m[a]in`). Each word is read with its quoting: an unquoted {a,b} or {a..b} in a guarded command
// (or in its command word) is denied; an unquoted glob in a guarded command is denied when it could match a denied token, a guarded
// subcommand or a protected branch (`git add *.mjs` stays allowed).
const GUARDED = /^(git|gh|npm|pnpm|yarn|bun|cargo|uv|twine|npx)$/;
// The words of a segment, each as [{ c, q }] (q: the character was quoted or escaped). Expansions are kept as unquoted text.
function quotedWords(seg) {
  const words = []; let cur = null;
  const push = (c, q) => { (cur ??= []).push({ c, q }); };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '\\') { if (seg[i + 1] === '\n') { i++; continue; } if (i + 1 < seg.length) push(seg[++i], true); continue; }
    if (ch === "'") { const e = seg.indexOf("'", i + 1), end = e < 0 ? seg.length : e; for (const c of seg.slice(i + 1, end)) push(c, true); if (cur === null) cur = []; i = end; continue; }
    if (ch === '"') { let j = i + 1; if (cur === null) cur = []; for (; j < seg.length && seg[j] !== '"'; j++) { if (seg[j] === '\\' && '$`"\\\n'.includes(seg[j + 1] ?? '')) { j++; if (seg[j] !== '\n') push(seg[j], true); } else push(seg[j], true); } i = j; continue; }
    if (/[\s;&|<>()]/.test(ch)) { if (cur) words.push(cur); cur = null; continue; }
    push(ch, false);
  }
  if (cur) words.push(cur);
  return words;
}
const plainOf = (w) => w.map((x) => x.c).join('');
// Brace expansion of one word ([{c,q}]): the alternatives, or null when it has no unquoted {a,b} / {a..b}.
function braceAlts(w) {
  for (let i = 0; i < w.length; i++) {
    if (w[i].c !== '{' || w[i].q) continue;
    let d = 0, commas = [], j = i;
    for (; j < w.length; j++) { const x = w[j]; if (x.q) continue; if (x.c === '{') d++; else if (x.c === '}' && --d === 0) break; else if (x.c === ',' && d === 1) commas.push(j); }
    if (j >= w.length) return null;
    const pre = plainOf(w.slice(0, i)), post = plainOf(w.slice(j + 1));
    if (commas.length) { const cuts = [i, ...commas, j]; return cuts.slice(1).map((c, k) => pre + plainOf(w.slice(cuts[k] + 1, c)) + post); }
    if (/^[^.]*\.\.[^.]*$/.test(plainOf(w.slice(i + 1, j)))) return [pre + post, pre + plainOf(w.slice(i + 1, j)) + post];
  }
  return null;
}
// An unquoted glob word as a RegExp, or null.
function globRe(w) {
  if (!w.some((x) => !x.q && /[*?[]/.test(x.c))) return null;
  let re = '';
  for (let i = 0; i < w.length; i++) {
    const { c, q } = w[i];
    if (q) { re += c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&'); continue; }
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') { let j = i + 1; if (w[j]?.c === '!' || w[j]?.c === '^') j++; if (w[j]?.c === ']') j++; while (j < w.length && w[j].c !== ']') j++; if (j >= w.length) { re += '\\['; continue; } let cls = plainOf(w.slice(i + 1, j)).replace(/^[!^]/, '^').replace(/\\/g, '\\\\'); re += `[${cls}]`; i = j; }
    else re += c.replace(/[\\^$.+()[\]{}|/-]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`); } catch { return /^/; }
}
const DANGER = () => [...PROBES, ...GIT_SUBS, ...GH_SUBS, 'publish', 'unpublish', 'deprecate', 'PUT', 'POST', 'DELETE', 'PATCH', '-XPUT', '-XDELETE', '--method', '--no-verify', '--force-with-lease', '--force-if-includes', '--prune', 'core.hooksPath', 'HUSKY', 'pre-commit'];
export function shapeReason(seg, cfg) {
  const ws = quotedWords(seg);
  let i = 0; while (i < ws.length && /^[A-Za-z_]\w*=/.test(plainOf(ws[i]))) i++;
  const head = ws[i];
  if (!head) return null;
  const alts = braceAlts(head);
  if (alts && alts.some((a) => GUARDED.test(base(a)))) return `brace expansion in the command word (${plainOf(head)}) can build a guarded command; write the command out`;
  const hg = globRe(head);
  if (hg && ['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'uv', 'twine', 'npx'].some((e) => hg.test(e))) return `a glob in the command word (${plainOf(head)}) can match a guarded command; write the command out`;
  if (!GUARDED.test(base(plainOf(head)))) return null;
  const danger = [...DANGER(), ...(cfg?.protectedBranches ?? [])];
  for (const w of ws.slice(i + 1)) {
    if (braceAlts(w)) return `brace expansion (${plainOf(w)}) in a ${base(plainOf(head))} command can build a denied word; ${SPELL}`;
    const re = globRe(w);
    if (re && !plainOf(w).includes('$')) { const hit = danger.find((t) => re.test(t)); if (hit) return `the unquoted glob ${plainOf(w)} in a ${base(plainOf(head))} command could match ${hit}; ${SPELL}`; }
  }
  return null;
}

// SID-191 re-review: guarded contexts are literal-only. Instead of matching dangerous shapes, every simple command of the line, of each
// segment and of each payload is read with its quoting:
//  (a) the command word must be a plain literal: no $ or backtick (quoted or not), no unquoted brace or glob, not a function on the line
//      that runs its arguments;
//  (b) an argument of a guarded command may not hold an unquoted glob (* ? [) or brace expansion ({a,b}, {a..b}), -c/--config-env
//      values included;
//  (c) a line that names a guarded command may not also change how words are read (shopt, set --/-o, IFS=, read, printf -v, mapfile,
//      alias, eval);
//  (d) a bash -c/sh -c payload is read by the same rules, and may not use positional parameters.
const LIT_GUARDED = /^(git|gh|npm|pnpm|yarn|bun|npx|cargo|uv|twine)$/;
const GUARD_WORD = /(?:^|[^\w.\/-])(?:[\w.\/-]*\/)?(git|gh|npm|pnpm|yarn|bun|npx|cargo|uv|twine)(?![\w.-])/;
const SKIP_HEAD = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'setsid', 'chrt', 'taskset', 'busybox', 'function']);
const OPT_ARG = { ...WRAPPERS };
const stripHeredocs = (t) => {
  const lines = t.split('\n'), out = [];
  for (let k = 0, pend = []; k < lines.length; k++) {
    if (pend.length) { if (lines[k].replace(/^\t+/, '') === pend[0]) pend.shift(); continue; }
    out.push(lines[k]);
    for (const m of lines[k].matchAll(/<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([\w.-]+))/g)) pend.push(m[1] ?? m[2] ?? m[3]);
  }
  return out.join('\n');
};
// Simple commands of a text, each a list of words, each word [{ c, q }] (q: quoted or escaped). Command boundaries: ; & | newline ( ) `
function litCommands(text) {
  const t = stripHeredocs(text), cmds = []; let words = [], cur = null;
  const push = (c, q) => { (cur ??= []).push({ c, q }); };
  const endWord = () => { if (cur) words.push(cur); cur = null; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\') { if (t[i + 1] === '\n') { i++; continue; } if (i + 1 < t.length) push(t[++i], true); continue; }
    if (ch === "'") { const e = t.indexOf("'", i + 1), end = e < 0 ? t.length : e; if (cur === null) cur = []; for (const c of t.slice(i + 1, end)) push(c, true); i = end; continue; }
    if (ch === '$' && t[i + 1] === "'") { const e = t.indexOf("'", i + 2), end = e < 0 ? t.length : e; if (cur === null) cur = []; for (const c of t.slice(i + 2, end)) push(c, true); i = end; continue; }
    if (ch === '"') { if (cur === null) cur = []; let j = i + 1; for (; j < t.length && t[j] !== '"'; j++) { if (t[j] === '\\' && '$`"\\\n'.includes(t[j + 1] ?? '')) { j++; if (t[j] !== '\n') push(t[j], true); } else if (t[j] === '$' || t[j] === '`') push(t[j], 'x'); else push(t[j], true); } i = j; continue; }
    if (ch === '#' && cur === null) { while (i < t.length && t[i] !== '\n') i++; endCmd(); continue; }
    if (/[;&|\n()`]/.test(ch)) { endCmd(); continue; }
    if (/[\s<>]/.test(ch)) { endWord(); continue; }
    push(ch, false);
  }
  endCmd();
  return cmds;
}
const lp = (w) => w.map((x) => x.c).join('');
const hasBrace = (w) => {
  for (let i = 0; i < w.length; i++) {
    if (w[i].q || w[i].c !== '{' || (i > 0 && !w[i - 1].q && w[i - 1].c === '$')) continue;
    let d = 0;
    for (let j = i; j < w.length; j++) {
      const x = w[j]; if (x.q) continue;
      if (x.c === '{') d++; else if (x.c === '}' && --d === 0) break;
      else if (x.c === ',' || (x.c === '.' && w[j + 1]?.c === '.' && !w[j + 1].q)) return true;
    }
  }
  return false;
};
const hasGlob = (w) => w.some((x) => !x.q && /[*?[]/.test(x.c));
const SPELL = "spell the paths or words out, e.g. git add src/a.ts src/b.ts, or quote the argument if the glob is meant literally: gh api 'repos/o/r/pulls?state=open', --jq '.[]', uv add 'pkg[extra]'";
export function literalReason(text) {
  for (let w of litCommands(text)) {
    let i = 0;
    for (let guard = 0; guard < 50 && i < w.length; guard++) {
      const h = lp(w[i]);
      if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(h) && !w[i][0].q) { i++; continue; }
      if (SKIP_HEAD.has(h) && !w[i][0].q) { i++; continue; }
      if (OPT_ARG[h] !== undefined && !w[i][0].q) { i++; while (i < w.length && /^-/.test(lp(w[i]))) { const o = lp(w[i]); i++; if (/^-[a-zA-Z]$/.test(o) && OPT_ARG[h].includes(o[1])) i++; } if (h === 'timeout' && /^\d/.test(lp(w[i] ?? []))) i++; if (h === 'env') while (i < w.length && /^[A-Za-z_]\w*=/.test(lp(w[i]))) i++; continue; }
      break;
    }
    const head = w[i];
    if (!head) continue;
    const hs = lp(head);
    if (['for', 'case', 'in', 'esac', 'done', 'fi', '}', '[', '[[', ']]', 'select'].includes(hs) && !head[0].q) continue;
    if (hs === '$' && w.length === i + 1) continue; // the `$` left where a segment was cut at `$(`: the substitution is a segment of its own
    if (head.some((x) => x.c === '$' && x.q !== true) || head.some((x) => x.c === '`')) return `the command word ${clip(hs, 80)} is an expansion, so the guard can't tell which command runs; write the command out`;
    if (hasBrace(head) || hasGlob(head)) return `the command word ${clip(hs, 80)} has an unquoted brace or glob, so the guard can't tell which command runs; write the command out`;
    if (!LIT_GUARDED.test(base(hs))) continue;
    for (const a of w.slice(i + 1)) {
      if (hasBrace(a)) return `brace expansion (${clip(lp(a), 80)}) in a ${base(hs)} command can expand to a denied word; ${SPELL}`;
      if (hasGlob(a)) return `the unquoted glob ${clip(lp(a), 80)} in a ${base(hs)} command can expand to a denied word; ${SPELL}`;
    }
  }
  return null;
}
const READERS = /^(shopt|read|mapfile|readarray|alias|eval)$/;
// `set -o NAME` for options that leave word reading alone; every other -o/+o name (noglob, braceexpand, posix, ...) and `set --` stay denied.
const SAFE_SET_OPTS = new Set(['pipefail', 'errexit', 'nounset', 'verbose', 'noclobber']);
const setReason = (args) => { if (!args.some((x) => x === '--' || /^[-+]o$/.test(x))) return false; for (let k = 0; k < args.length; k += 2) if (!/^[-+]o$/.test(args[k]) || !SAFE_SET_OPTS.has(args[k + 1])) return true; return false; }; // with any -o/+o or `--`, every argument must be a `-o NAME`/`+o NAME` pair with a safe name (a stray -k, -f, +B, `-` or bare word is denied, as at b2b5fd7)
// IFS=x counts when it is an assignment word, judged on the parsed words. The raw-text check (b2b5fd7: IFS= after whitespace or a separator, or after export/declare/...) stays the rule,
// and is lifted only when the whole text is provably data: plain quoting (no backslash, comment, $( ), backtick, $'..', redirection, parenthesis or brace outside quotes), every command
// one of a few that run nothing from their arguments (echo, printf, a git/gh message command, ls, cat, ...), and no word of litCommands that begins with an unquoted IFS=.
// An unknown command, `sh`, `eval`, `trap`, an interpreter, `tee`, `xargs` ... is not on the list, so text a script could read back keeps the raw rule.
const IFS_ASSIGN = /(?:^|[\s;&|(`]|\b(?:export|declare|local|readonly|typeset)\s+)IFS\+?=/;
const PLAIN_HEADS = new Set(['echo', 'printf', 'true', 'false', ':', 'cd', 'pwd', 'ls', 'cat', 'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'tr', 'sleep', 'mkdir', 'touch']);
const MSG_OPTS = /^(-m|--message|-t|--title|-b|--body)$/;
function plainQuoting(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'") { const e = t.indexOf("'", i + 1); if (e < 0) return false; i = e; }
    else if (c === '"') { for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\' || t[i] === '`' || (t[i] === '$' && '([{'.includes(t[i + 1]))) return false; if (i >= t.length) return false; }
    else if ('\\#<>(){}`'.includes(c) || (c === '$' && (t[i + 1] === "'" || t[i + 1] === '(' || t[i + 1] === '['))) return false;
  }
  return true;
}
const unquotedPrefix = (w, n) => w.slice(0, n).every((x) => !x.q);
function ifsMentionIsData(text) {
  if (!plainQuoting(text)) return false;
  for (const w of litCommands(text)) {
    const h = lp(w[0]);
    if (!unquotedPrefix(w[0], w[0].length)) return false;
    const hasQuoted = (x) => x.some((y) => y.q);
    if (PLAIN_HEADS.has(h)) { /* arguments are data */ }
    else if (h === 'git') { if (w.some((x, k) => k > 1 && hasQuoted(x) && !(MSG_OPTS.test(lp(w[k - 1] ?? [])) && ['commit', 'tag', 'notes', 'stash'].includes(lp(w[1]))))) return false; }
    else if (h === 'gh' && /^(pr|issue)$/.test(lp(w[1] ?? [])) && /^(create|comment|edit)$/.test(lp(w[2] ?? []))) { if (w.some((x, k) => k > 2 && hasQuoted(x) && !MSG_OPTS.test(lp(w[k - 1] ?? [])))) return false; }
    else return false;
    for (const x of w) { const m = /^IFS\+?=/.exec(lp(x)); if (m && unquotedPrefix(x, m[0].length)) return false; } // a real assignment word, at any position
  }
  return true;
}
const setsIfs = (text) => IFS_ASSIGN.test(text) && !ifsMentionIsData(text);
export function rereadReason(text) {
  if (!GUARD_WORD.test(text) && !GUARD_WORD.test(canon(text).text)) return null;
  if (setsIfs(text)) return 'this line sets IFS and names a guarded command; word splitting could build a denied command, so run them separately';
  for (const w of litCommands(text)) {
    const ws = w.map(lp);
    let i = 0; while (i < ws.length && (/^[A-Za-z_]\w*=/.test(ws[i]) || SKIP_HEAD.has(ws[i]) || OPT_ARG[ws[i]] !== undefined)) i++;
    const h = ws[i] ?? '';
    if (READERS.test(h) || (h === 'set' && setReason(ws.slice(i + 1))) || (h === 'printf' && ws.slice(i + 1).some((x) => /^-v/.test(x))) || ((h === 'declare' || h === 'typeset') && ws.some((x) => /^-[a-zA-Z]*[n]/.test(x))))
      return `${h} on a line that names a guarded command can change how later words are read; run the guarded command on its own line, written out`;
  }
  return null;
}
const POSITIONAL = /\$(?:[@*#1-9]|\{[@*#!1-9])|(?:^|[\s;&|(])shift(?=$|[\s;&|)])/;

// Every segment that may run: segments() of the line, and each segment again with its own quoting resolved (text inside $( ),
// sh -c '..' and piped-in scripts is unquoted only once it is a segment of its own).
export function guardSegments(cmd) {
  const segs = [], seen = new Set(), defs = functionDefs(cmd);
  segs.payloads = []; segs.tooDeep = false;
  for (const todo = segments(cmd).map((s) => [s, 0]); todo.length;) { // the whole line's canon form adds nothing: each segment below is re-read with its quoting resolved (a mutation dropping it survived)
    const [s, d] = todo.shift();
    if (seen.has(s)) continue;
    seen.add(s); segs.push(s);
    const c = canon(s);
    if (!c.open && c.text !== s) todo.push(...segments(c.text).map((x) => [normalize(x), d]).filter((x) => x[0]));
    // SID-191 review B1/B5: what this segment hands to another shell, read as that shell reads it
    const runs = runsText(s, defs);
    if (runs.positional !== undefined) segs.positional ??= runs.positional;
    for (const p of runs) {
      if (d + 1 > PAYLOAD_DEPTH) { segs.tooDeep = true; break; }
      if (segs.payloads.includes(p)) continue;
      segs.payloads.push(p);
      todo.push(...segments(p).map((x) => [normalize(x), d + 1]).filter((x) => x[0]));
    }
  }
  return segs;
}
// The first segment the rules deny, with why; null when none does.
export function segmentReason(cmd, cfg, branch, segs = guardSegments(cmd)) {
  const vars = assignments(cmd);
  if (segs.tooDeep) return { why: `shell -c / eval payloads are nested more than ${PAYLOAD_DEPTH} deep, so the guard can't read what runs; run the command directly`, seg: cmd };
  // SID-191 review B1: a payload gets the whole-line checks too (core.hooksPath, hidden config, an unclosed quote)
  for (const p of segs.payloads ?? []) { const why = lineReason(p); if (why) return { why, seg: p }; }
  if (segs.positional !== undefined) return { why: 'a bash -c / sh -c script that uses positional parameters ($1, $@, shift, ...) can run its arguments as a command; write the command into the script', seg: segs.positional };
  const quoted = quotedGitOption(cmd, segs);
  if (quoted) return { why: NO_QUOTED_GLOBAL(quoted), seg: cmd };
  const noStat = !keepsHookRule(segs, cmd);
  for (const seg of segs) {
    const why = reason(seg, cfg, branch, noStat) ?? expansionReason(seg, cfg, branch, vars) ?? shapeReason(seg, cfg);
    if (why) return { why, seg };
  }
  // SID-191 re-review: literal-only command words and arguments (on the line and each shell payload, not on split artifacts); reread builtins near a guarded word
  for (const t of [cmd, ...(segs.payloads ?? [])]) { const why = literalReason(t); if (why) return { why, seg: t }; }
  for (const t of [cmd, ...segs, ...(segs.payloads ?? [])]) { const why = rereadReason(t); if (why) return { why, seg: t }; }
  // expansions, on the commands with their substitutions whole (segments() cuts them out), as written and with quoting resolved
  for (const seg of new Set([cmd, canon(cmd).text].flatMap((t) => outerCommands(t)))) {
    const why = expansionReason(seg, cfg, branch, vars);
    if (why) return { why, seg };
  }
  return null;
}
