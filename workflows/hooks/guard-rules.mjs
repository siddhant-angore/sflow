import { gitWrites, segments } from './lib.mjs';
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
    [/^git\s+remote\s+set-head\b/, (a) => (a.some((x) => /^(-a|--auto)$/.test(x)) && !a.some((x) => /^(-d|--delete)$/.test(x)) ? null : NO_SET_HEAD)],
    [/^git\s+symbolic-ref\b/, () => symrefReason(raw)],
    [/^git\s+(fetch|pull)\b/, (a) => { const dsts = a.filter((x) => !x.startsWith('-')).map((x) => x.replace(/^\+/, '').split(':').slice(1).join(':')); return dsts.some(isReplaceRef) ? NO_REPLACE : dsts.some(isRemoteRef) ? NO_FETCH_DST : null; }],
    [/^git\s+config\b/, (a) => {
      const pos = a.filter((x, i) => !x.startsWith('-') && !/^(--file|-f|--blob)$/.test(a[i - 1] ?? ''));
      const writes = a.some((x) => /^--(add|replace-all|unset|unset-all)$/.test(x)) || ['set', 'unset'].includes(pos[0]);
      const reads = a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list)$/.test(x)) || pos[0] === 'get';
      const hit = (re) => pos.findIndex((x) => re.test(x));
      const bad = (re, msg) => { const k = hit(re); return k >= 0 && (writes || (!reads && pos.length > k + 1)) ? msg : null; };
      return bad(/^remote\..+\.fetch$/i, NO_FETCH_CFG) ?? bad(DISCOVERY_KEY, NO_DISCOVERY_CFG);
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
  if (/core\.hooksPath/.test(cmd)) return 'overriding core.hooksPath disables the project hooks';
  if (/(^|\s)-c\s*["']?remote\.[^\s=]+\.fetch\s*=|--config-env[=\s]+["']?remote\.[^\s=]+\.fetch\b|\bGIT_CONFIG_KEY_\d+=["']?remote\.[^\s=]+\.fetch\b/i.test(cmd)) return NO_FETCH_OVERRIDE;
  if (/(^|\s)-c\s*["']?(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.[^\s='"]+)["']?(\s*=|\s|$)|--config-env[=\s]+["']?(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.[^\s=]+)\s*=|\bGIT_CONFIG_KEY_\d+=["']?(core\.(bare|repositoryformatversion|worktree)|include\.path|includeif\.\S+?)["']?(\s|$)/i.test(cmd)) return NO_DISCOVERY_CFG;
  const params = /\bGIT_CONFIG_PARAMETERS=("[^"]*"|'[^']*'|\S*)/.exec(cmd);
  if (params && FETCH_KEY.test(params[1])) return NO_FETCH_OVERRIDE;
  if (params && DISCOVERY_ENV.test(params[1])) return NO_DISCOVERY_CFG;
  if (/\b(HUSKY|LEFTHOOK|SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG)=/.test(cmd)) return 'disabling commit hooks by environment is not allowed';
  const writes = gitWrites(cmd).map((w) => w.kind);
  if (writes.includes('config')) return 'writing a git config file directly can make git run commands (core.pager, core.sshCommand, aliases, filters); use `git config <key> <value>` instead';
  if (writes.includes('hooks')) return 'writing into a hooks directory installs code git runs automatically; ask the user, or use the harness hook setup';
  if (writes.length && segments(cmd).some((s) => /^git\b/.test(s))) return 'a write into .git/info or .git/modules is followed by a git command on the same line; git may run what was written; do the write on its own and review it';
  return null;
}
