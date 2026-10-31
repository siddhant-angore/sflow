// Pure rule table over one normalized shell segment. Returns the reason to deny, or null.
const headRef = (r) => r === 'HEAD' || r === '@';
// The protected branch a refspec pushes to (+ stripped, no colon means dst = src, HEAD and @ resolve to the current branch), or null. viaHead: the name came from the checkout, not from the text.
const protectedTarget = (tok, prot, branch) => {
  const p = tok.replace(/^\+/, '').split(':'), raw = p.length > 1 ? p.pop() : p[0];
  const dst = headRef(raw) ? branch : raw.replace(/^refs\/heads\//, '');
  return prot.includes(dst) ? { name: dst, viaHead: headRef(raw) } : null;
};

export function pushReason(seg, prot, branch) {
  const m = /^git\s+push\b(.*)$/.exec(seg);
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
  const targets = refs.slice(1);
  if (targets.length === 0 && branch && prot.includes(branch)) return `you are on protected branch ${branch}; create a feature branch and push that`;
  const hit = targets.map((t) => protectedTarget(t, prot, branch)).find(Boolean);
  if (hit?.viaHead) return `HEAD/@ here is protected branch ${hit.name}; create a feature branch (git switch -c <name>), push it and open a PR`;
  if (hit) return `direct push to a protected branch (${prot.join(', ')}); push a feature branch and open a PR`;
  if (flags.some((f) => f.startsWith('--force-with-lease')) && targets.length === 0 && branch && prot.includes(branch)) return 'lease push to a protected branch';
  return null;
}

const unquoted = (s) => s.replace(/"[^"]*"|'[^']*'/g, '""');

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
    [/^git\s+(filter-branch|filter-repo|replace)\b|^git\s+update-ref\s+-d\b|^git\s+reflog\s+expire\b|^git\s+gc\b.*--prune/, 'history rewriting is not allowed'],
    [/^git\s+push\b/, null],
    [/^gh\s+api\b.*(\s-X\s*(PUT|POST|PATCH|DELETE)|\s--method\s*(PUT|POST|PATCH|DELETE)|\s--input\b|\s-F\b|\s-f\b)/, 'write calls to the GitHub API are not allowed from an agent; use gh pr create/edit/comment'],
    [/^gh\s+(release|repo\s+delete|repo\s+archive|secret|variable|workflow\s+(run|enable|disable))\b/, 'releases, repo lifecycle, secrets, and workflow triggers are human actions'],
    [/^(npm|pnpm|yarn|bun)\s+publish\b|^npm\s+(deprecate|unpublish)\b|^cargo\s+publish\b|^uv\s+publish\b|^twine\b/, 'publishing a package is a human action'],
    [/^gh\s+pr\s+merge\b|^gh\s+pr\s+close\b/, allowMerge ? null : 'merging or closing a PR is a human or Shipping-playbook decision; set allowMerge in .harness.json on the protected branch'],
  ];
  for (const [re, why] of rules) if (why && re.test(seg)) return why;
  return null;
}

export function envReason(cmd) {
  if (/core\.hooksPath/.test(cmd)) return 'overriding core.hooksPath disables the project hooks';
  if (/\b(HUSKY|LEFTHOOK|SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG)=/.test(cmd)) return 'disabling commit hooks by environment is not allowed';
  return null;
}
