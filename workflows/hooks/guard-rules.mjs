import { isPolicyPath, policyDeny, policyGlobHit } from './lib.mjs';
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
const REMOTE_REFS = 'remote-tracking refs locate the harness policy; rewriting them locally is not allowed (git fetch updates them)';
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
    [/^git\s+(filter-branch|filter-repo|replace)\b|^git\s+update-ref\s+-d\b|^git\s+reflog\s+expire\b|^git\s+gc\b.*--prune/, 'history rewriting is not allowed'],
    [/^git\s+push\b/, null],
    [/^git\s+remote\s+set-head\b/, (a) => (a.some((x) => /^(-a|--auto)$/.test(x)) && !a.some((x) => /^(-d|--delete)$/.test(x)) ? null : REMOTE_REFS)],
    [/^git\s+symbolic-ref\b/, (a) => { const pos = a.filter((x) => !x.startsWith('-')); return (a.some((x) => /^(-d|--delete)$/.test(x)) ? pos.some(isRemoteRef) : pos.length > 1 && isRemoteRef(pos[0])) ? REMOTE_REFS : null; }],
    [/^git\s+update-ref\b/, (a) => (a.some(isRemoteRef) ? REMOTE_REFS : null)],
    [/^git\s+fetch\b/, (a) => (a.some((x) => !x.startsWith('-') && isRemoteRef(x.replace(/^\+/, '').split(':').slice(1).join(':'))) ? REMOTE_REFS : null)],
    [/^git\s+config\b/, (a) => {
      const pos = a.filter((x) => !x.startsWith('-'));
      const k = pos.findIndex((x) => /^remote\..+\.fetch$/i.test(x));
      if (k < 0) return null;
      const writes = a.some((x) => /^--(add|replace-all|unset|unset-all)$/.test(x)) || ['set', 'unset'].includes(pos[0]);
      const reads = a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list)$/.test(x)) || pos[0] === 'get';
      return writes || (!reads && pos.length > k + 1) ? REMOTE_REFS : null;
    }],
    [/^gh\s+api\b.*(\s-X\s*(PUT|POST|PATCH|DELETE)|\s--method\s*(PUT|POST|PATCH|DELETE)|\s--input\b|\s-F\b|\s-f\b)/, 'write calls to the GitHub API are not allowed from an agent; use gh pr create/edit/comment'],
    [/^gh\s+(release|repo\s+(delete|archive|edit)|secret|variable|workflow\s+(run|enable|disable))\b/, 'releases, repo lifecycle and settings, secrets, and workflow triggers are human actions'],
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
  if (/(^|\s)-c\s*["']?remote\.[^\s=]+\.fetch\s*=|--config-env[=\s]+["']?remote\.[^\s=]+\.fetch\b|\bGIT_CONFIG_(PARAMETERS|COUNT)=|\bGIT_CONFIG_KEY_\d+=["']?remote\.[^\s=]+\.fetch\b/i.test(cmd)) return REMOTE_REFS;
  if (/\b(HUSKY|LEFTHOOK|SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG)=/.test(cmd)) return 'disabling commit hooks by environment is not allowed';
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
      if (ch === '&') i++; // &>
      if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') { hd = true; i++; if (s[i + 1] === '-') i++; } else if (ch === '<' && s[i + 1] === '<') i += 2; // << heredoc delimiter, <<< here-string
      else if (s[i + 1] === '>' || s[i + 1] === '|' || s[i + 1] === '&') i++; // >> >| >& <>
      mode = ch === '<' ? 'in' : 'out';
    }
    else if (/\s/.test(ch)) word();
    else cur = (cur ?? '') + ch;
  }
  sep();
  return cmds;
}

const WRAP = /^(sudo|doas|command|exec|nohup|time|nice|env|builtin|setsid)$/;
const INTERP = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/;
const POLICY_NAME = /\.harness\.json|\.claude\/settings(\.local)?\.json|\.claude['"]?\s*,\s*['"]settings(\.local)?\.json/i;
// Best-effort list of write/delete calls in an inline script (node/python/ruby/perl/deno/bun). Reads are not matched.
const WRITE_CALL = /writeFile|appendFile|writeSync|createWriteStream|rename|unlink|\brmSync|\brm\b|copyFile|symlink|\blink\(|truncate|write_text|write_bytes|File\.(write|delete|rename|open)|os\.(remove|rename|replace)|shutil\.|Deno\.write|Bun\.write|,\s*['"](?:[wax]|r\+)[bt]?\+?['"]/;
const P = (x) => isPolicyPath(x) || policyGlobHit(x);
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
function oneCommand({ w, r }, depth, out) {
  for (const x of r) { out.through.push(x); if (P(x)) out.hit ??= x; }
  let i = 0;
  while (i < w.length && (/^[A-Za-z_]\w*=/.test(w[i]) || WRAP.test(base(w[i])))) { const wrap = WRAP.test(base(w[i])); i++; while (wrap && w[i]?.startsWith('-')) i++; }
  const name = base(w[i] ?? ''); let args = w.slice(i + 1);
  if (!name) return;
  const hitAny = (xs) => { for (const x of xs) if (P(x)) out.hit ??= x; };
  if (/^(sh|bash|zsh|dash|ksh)$/.test(name)) { const k = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)); if (k >= 0 && args[k + 1] && depth < 3) scan(args[k + 1], depth + 1, out); return; }
  if (name === 'eval') { if (depth < 3) scan(args.join(' '), depth + 1, out); return; }
  if (name === 'git') {
    while (args[0]?.startsWith('-')) args = args.slice(/^-(C|c)$|^--(git-dir|work-tree|exec-path)$/.test(args[0]) ? 2 : 1);
    const sub = args[0], { flags, pos } = split(args.slice(1));
    const dirHit = () => { if (pos.some(isClaudeDir)) out.hit ??= CLAUDE_DIR_HIT; };
    if (sub === 'checkout') { hitAny(pos); dirHit(); }
    else if (sub === 'restore') { if (!(flags.some((f) => f === '--staged' || f === '-S') && !flags.some((f) => f === '--worktree' || f === '-W'))) { hitAny(pos); dirHit(); } }
    else if (sub === 'mv') { hitAny(pos); dirHit(); }
    else if (sub === 'rm') { if (!flags.includes('--cached')) { hitAny(pos); dirHit(); } }
    return;
  }
  if (INTERP.test(name)) {
    const text = args.join(' '), inline = args.some((a, k) => (k === 0 && name === 'deno' && a === 'eval') || /^(--eval|--print|-[a-zA-Z]*[ecEp])$/.test(a));
    if (inline && POLICY_NAME.test(text) && WRITE_CALL.test(text)) out.hit ??= (text.match(POLICY_NAME)[0].replace(/['"\s,]+/, '/'));
    if (/^(perl|ruby)$/.test(name) && args.some((a) => /^-(?![MIm])[A-Za-z]*i\S*$/.test(a))) { const e = args.findIndex((a) => /^-[A-Za-z]*[eE]$/.test(a)); hitAny(args.filter((a, k) => !a.startsWith('-') && k !== e + 1)); }
    return;
  }
  const { flags, pos, t } = split(args, /^(cp|mv|ln|install)$/.test(name));
  if (name === 'tee') { for (const x of pos) { out.through.push(x); if (P(x)) out.hit ??= x; } return; }
  if (/^(cp|install|rsync|ln|mv)$/.test(name)) {
    const dest = t ?? pos.at(-1), srcs = t ? pos : pos.slice(0, -1);
    if (dest === undefined) { if (name === 'ln') hitAny(pos); return; }
    if (name !== 'mv') out.through.push(dest);
    const pol = srcs.map(base).filter((b) => /^(\.harness\.json|settings(\.local)?\.json)$/i.test(b));
    if (pol.length) out.into.push({ dest, names: pol }); // pre-bash checks whether dest is an existing directory
    if (P(dest)) out.hit ??= dest;
    else if (base(dest) === '.claude' && srcs.some((x) => /^settings(\.local)?\.json$/i.test(base(x)))) out.hit ??= '.claude/settings.json';
    else if (isDirish(dest) && srcs.some((x) => base(x).toLowerCase() === '.harness.json')) out.hit ??= '.harness.json';
    if (name === 'ln' || name === 'mv') hitAny(pos);
    if (name === 'mv' ? [...srcs, dest].some(isClaudeDir) : isClaudeDir(dest) && srcs.some(isClaudeDir)) out.hit ??= CLAUDE_DIR_HIT;
    return;
  }
  if (/^(rm|unlink|truncate|shred)$/.test(name)) { if (name !== 'rm' && name !== 'unlink') out.through.push(...pos); hitAny(pos); if (name === 'rm' && recursive(flags) && pos.some(isClaudeDir)) out.hit ??= CLAUDE_DIR_HIT; return; }
  if (name === 'dd') { for (const a of args) if (a.startsWith('of=')) { out.through.push(a.slice(3)); if (P(a.slice(3))) out.hit ??= a.slice(3); } return; }
  if (name === 'sed') { if (flags.some((f) => /^-[A-Za-z]*i|^--in-place/.test(f))) { const sc = flags.filter((f) => /^-[A-Za-z]*[ef]$|^--(expression|file)$/.test(f)).length; hitAny(pos.slice(sc || flags.some((f) => /^-[A-Za-z]*[ef]\S|^--(expression|file)=/.test(f)) ? sc : 1)); } return; } // script words (the first positional, or one per -e/-f) are not files
  if (/^(ed|ex|vim|vi|nano|emacs)$/.test(name)) hitAny(pos);
}

function scan(text, depth, out) { for (const c of simpleCommands(text)) oneCommand(c, depth, out); return out; }
// { hit, through }: hit is the first policy path the command writes, creates, replaces, moves, links or deletes; through lists paths written through (symlink check in pre-bash), into lists copies of a policy-named file to a destination that is a directory if it exists (checked in pre-bash).
export const analyzeWrites = (cmd) => scan(String(cmd), 0, { hit: null, through: [], into: [] });
export const policyWriteReason = (cmd) => { const { hit } = analyzeWrites(cmd); return hit ? policyDeny(hit) : null; };
