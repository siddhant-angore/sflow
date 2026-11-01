import { posix } from 'node:path';
import { gitWrites, isPolicyPath, policyDeny, policyGlobHit, segments, sortOut, take, uniqOut, unwrap, WRAPPERS } from './lib.mjs';
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

export function reason(raw, { protectedBranches: prot, allowMerge, unreadable }, branch) {
  const p = pushReason(raw, prot, branch);
  if (p) return p;
  const seg = unquoted(raw);
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
      return bad(/^remote\..+\.fetch$/i, NO_FETCH_CFG) ?? bad(DISCOVERY_KEY, NO_DISCOVERY_CFG) ?? bad(/^core\.hookspath$/i, NO_HOOKS_CFG) ?? bad(/^sflow\./i, NO_HOOKS_CFG);
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
  const params = /\bGIT_CONFIG_PARAMETERS=("[^"]*"|'[^']*'|\S*)/.exec(cmd);
  if (params && FETCH_KEY.test(params[1])) return NO_FETCH_OVERRIDE;
  if (params && DISCOVERY_ENV.test(params[1])) return NO_DISCOVERY_CFG;
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
