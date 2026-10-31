// Pure rule table over one normalized shell segment. Returns the reason to deny, or null.
const protectedToken = (tok, prot) => {
  const dst = tok.replace(/^\+/, '').split(':').pop();
  return prot.includes(dst) || prot.some((b) => dst === `refs/heads/${b}`);
};

export function pushReason(seg, prot, branch) {
  const m = /^git\s+push\b(.*)$/.exec(seg);
  if (!m) return null;
  const args = m[1].trim().split(/\s+/).filter(Boolean);
  const flags = args.filter((a) => a.startsWith('-'));
  const refs = args.filter((a) => !a.startsWith('-'));
  if (args.some((a) => /[$`]/.test(a))) return 'push arguments must be literal, no shell expansion';
  if (flags.some((f) => f === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) return 'force push is never allowed; make a new commit';
  if (flags.some((f) => /^--mirror|^--delete|^-d$|^--tags$|^--all$/.test(f))) return 'mirror, delete, --all, and --tags pushes are not allowed';
  if (flags.some((f) => /^--no-verify$/.test(f))) return 'hooks are the gate; --no-verify is not allowed';
  if (refs.some((r) => r.startsWith('+') || /^:/.test(r))) return 'a + refspec or a :branch deletion is a force or a delete';
  const targets = refs.slice(1);
  if (targets.length === 0 && branch && prot.includes(branch)) return `you are on protected branch ${branch}; create a feature branch and push that`;
  if (targets.some((t) => protectedToken(t, prot))) return `direct push to a protected branch (${prot.join(', ')}); push a feature branch and open a PR`;
  if (flags.some((f) => f.startsWith('--force-with-lease')) && targets.length === 0 && branch && prot.includes(branch)) return 'lease push to a protected branch';
  return null;
}

const unquoted = (s) => s.replace(/"[^"]*"|'[^']*'/g, '""');
const NO_SET_HEAD = "harness policy is read from origin/HEAD's branch, so it is not set locally. Use `git remote set-head origin --auto` to sync it with the remote; changing the default branch is a repo-admin action on GitHub.";
const NO_SYMREF = 'refs/remotes/* locate the harness policy, so they are not written locally. Read them with `git symbolic-ref --short refs/remotes/origin/HEAD`; sync them with `git fetch origin` or `git remote set-head origin --auto`.';
const NO_UPDATE_REF = 'refs/remotes/* locate the harness policy, so they are not written locally. Update them with `git fetch origin`; to move a local branch use `git update-ref refs/heads/<name> <commit>`.';
const NO_FETCH_DST = 'refs/remotes/* locate the harness policy, so fetch may not write them through an explicit refspec. Use `git fetch origin <branch>` (it updates origin/<branch> itself) or fetch into a local branch: `git fetch origin <branch>:<local-branch>`.';
const NO_FETCH_CFG = 'remote.<name>.fetch decides what refs/remotes/* hold, which locates the harness policy. Fetch a branch with `git fetch origin <branch>`; read the setting with `git config --get-all remote.origin.fetch`; changing it is a human action.';
const NO_FETCH_OVERRIDE = 'a per-command remote.<name>.fetch override can rewrite refs/remotes/*, which locate the harness policy. Use `git fetch origin <branch>` instead; other -c settings are fine.';
const NO_REPO_EDIT = 'repository settings (including the default branch, which locates the harness policy) are a repo-admin action on GitHub. Read them with `gh repo view --json <fields>`; ask a human to change them.';
const FETCH_KEY = /remote\.[^\s='"]+\.fetch\b/i;
const isRemoteRef = (x) => /^(refs\/)?remotes\//.test(x);

export function reason(raw, { protectedBranches: prot, allowMerge }, branch) {
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
    [/^git\s+update-ref\b/, (a) => (a.some(isRemoteRef) ? NO_UPDATE_REF : null)],
    [/^git\s+(filter-branch|filter-repo|replace)\b|^git\s+update-ref\s+-d\b|^git\s+reflog\s+expire\b|^git\s+gc\b.*--prune/, 'history rewriting is not allowed'],
    [/^git\s+push\b/, null],
    [/^git\s+remote\s+set-head\b/, (a) => (a.some((x) => /^(-a|--auto)$/.test(x)) && !a.some((x) => /^(-d|--delete)$/.test(x)) ? null : NO_SET_HEAD)],
    [/^git\s+symbolic-ref\b/, (a) => { const pos = a.filter((x) => !x.startsWith('-')); return (a.some((x) => /^(-d|--delete)$/.test(x)) ? pos.some(isRemoteRef) : pos.length > 1 && isRemoteRef(pos[0])) ? NO_SYMREF : null; }],
    [/^git\s+(fetch|pull)\b/, (a) => (a.some((x) => !x.startsWith('-') && isRemoteRef(x.replace(/^\+/, '').split(':').slice(1).join(':'))) ? NO_FETCH_DST : null)],
    [/^git\s+config\b/, (a) => {
      const pos = a.filter((x) => !x.startsWith('-'));
      const k = pos.findIndex((x) => /^remote\..+\.fetch$/i.test(x));
      if (k < 0) return null;
      const writes = a.some((x) => /^--(add|replace-all|unset|unset-all)$/.test(x)) || ['set', 'unset'].includes(pos[0]);
      const reads = a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list)$/.test(x)) || pos[0] === 'get';
      return writes || (!reads && pos.length > k + 1) ? NO_FETCH_CFG : null;
    }],
    [/^gh\s+api\b.*(\s-X\s*(PUT|POST|PATCH|DELETE)|\s--method\s*(PUT|POST|PATCH|DELETE)|\s--input\b|\s-F\b|\s-f\b)/, 'write calls to the GitHub API are not allowed from an agent; use gh pr create/edit/comment'],
    [/^gh\s+(release|repo\s+delete|repo\s+archive|secret|variable|workflow\s+(run|enable|disable))\b/, 'releases, repo lifecycle, secrets, and workflow triggers are human actions'],
    [/^gh\s+repo\s+edit\b/, NO_REPO_EDIT],
    [/^(npm|pnpm|yarn|bun)\s+publish\b|^npm\s+(deprecate|unpublish)\b|^cargo\s+publish\b|^uv\s+publish\b|^twine\b/, 'publishing a package is a human action'],
    [/^gh\s+pr\s+merge\b|^gh\s+pr\s+close\b/, allowMerge ? null : 'merging or closing a PR is a human or Shipping-playbook decision; set allowMerge in .harness.json on the base branch on origin'],
  ];
  const args = raw.replace(/["']/g, '').split(/\s+/).slice(2); // quotes dropped so a quoted refspec cannot hide
  for (const [re, rule] of rules) {
    const why = typeof rule === 'function' ? rule(args) : rule;
    if (why && re.test(seg)) return why;
  }
  return null;
}

export function envReason(cmd) {
  if (/core\.hooksPath/.test(cmd)) return 'overriding core.hooksPath disables the project hooks';
  if (/(^|\s)-c\s*["']?remote\.[^\s=]+\.fetch\s*=|--config-env[=\s]+["']?remote\.[^\s=]+\.fetch\b|\bGIT_CONFIG_KEY_\d+=["']?remote\.[^\s=]+\.fetch\b/i.test(cmd)) return NO_FETCH_OVERRIDE;
  const params = /\bGIT_CONFIG_PARAMETERS=("[^"]*"|'[^']*'|\S*)/.exec(cmd);
  if (params && FETCH_KEY.test(params[1])) return NO_FETCH_OVERRIDE;
  if (/\b(HUSKY|LEFTHOOK|SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG)=/.test(cmd)) return 'disabling commit hooks by environment is not allowed';
  return null;
}
