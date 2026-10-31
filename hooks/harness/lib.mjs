import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = { protectedBranches: ['main', 'master'], gate: [], allowMerge: false, dod: [] };
export const PLACEHOLDER = 'replace with the project checks';

export function readEvent() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; }
}

export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

export function repoRoot(cwd = process.cwd()) {
  try { return git(cwd, 'rev-parse', '--show-toplevel'); } catch { return null; }
}

// The policy comes from the protected branch on origin, so an agent edit in the working tree changes nothing.
// A repo without .harness.json anywhere is not under the harness: config().present is false.
export function config(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (!root) return { ...DEFAULTS, root: null, present: false };
  const local = join(root, '.harness.json');
  let text = null, source = null;
  for (const b of DEFAULTS.protectedBranches) {
    try { text = git(root, 'show', `origin/${b}:.harness.json`); source = `origin/${b}`; break; } catch {}
  }
  if (text === null && existsSync(local)) { text = readFileSync(local, 'utf8'); source = 'working tree'; }
  if (text === null) return { ...DEFAULTS, root, present: false };
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.protectedBranches)) delete parsed.protectedBranches;
  return { ...DEFAULTS, ...parsed, root, present: true, source };
}

export const gitDir = (root) => git(root, 'rev-parse', '--absolute-git-dir');
export const currentBranch = (root) => { try { return git(root, 'symbolic-ref', '--short', 'HEAD'); } catch { return null; } };

// Canonical form of one segment, so every rule can anchor on ^git <sub>: `env -i A=1 /usr/bin/git -P -c k=v push` becomes `git push`.
// Strips leading keywords, VAR=x, wrappers (and their options), a path or backslash on git/gh/npm..., then git's global options.
// Indirection (`g=git; $g push -f`, aliases, `sh -c '...'`, scripts written then run) stays best-effort: SID-77/78.
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const EXES = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'uv', 'twine']);
const WRAPPERS = { env: 'uC', command: '', builtin: '', exec: 'a', nice: 'n', nohup: '', time: 'of', timeout: 'ks', stdbuf: 'ioe', ionice: 'cnpPu', sudo: 'ugCDhprtTU', doas: 'uC', xargs: 'nILPsdEa' }; // short options that take a separate argument
const LONG_ARG = new Set(['--user', '--group', '--chdir', '--unset', '--host', '--prompt', '--role', '--type', '--other-user', '--close-from', '--command-timeout', '--adjustment', '--kill-after', '--signal', '--max-args', '--max-procs', '--max-lines', '--replace', '--delimiter', '--eof', '--arg-file']);
const GIT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--list-cmds']);
const take = (s) => { const m = /^\s*((?:"[^"]*"|'[^']*'|\S)+)\s*/.exec(s); return m ? [m[1], s.slice(m[0].length)] : [null, '']; };

function unwrap(name, rest) {
  for (;;) {
    const [t, r] = take(rest);
    if (t === null || !(t.startsWith('-') || (name === 'env' && /^\w+=/.test(t)))) break;
    rest = r;
    if (t === '--') break;
    const m = name === 'env' && /^(-S|--split-string)=?(.*)$/.exec(t);
    if (m) { const [v, after] = m[2] ? [m[2], r] : take(r); rest = `${(v ?? '').replace(/^(["'])(.*)\1$/, '$2')} ${after}`; continue; }
    if ((t.length === 2 && WRAPPERS[name].includes(t[1])) || LONG_ARG.has(t)) rest = take(r)[1];
  }
  return name === 'timeout' ? take(rest)[1] : rest;
}

// Drop git's global options (everything starting with - before the subcommand, plus the argument of those that take one).
function gitSub(rest) {
  for (;;) {
    const [o, r] = take(rest);
    if (!o?.startsWith('-')) return rest;
    rest = GIT_ARG.has(o) ? take(r)[1] : r;
  }
}

export function normalize(seg) {
  let s = seg.trim();
  for (let prev = null; prev !== s;) {
    prev = s;
    const [t, rest] = take(s);
    if (t === null) break;
    const b = /^\\?(?:[^\s"'=\\]*\/)?([\w.+-]+)$/.exec(t)?.[1] ?? t;
    if (KEYWORDS.has(t) || /^[A-Za-z_]\w*\+?=/.test(t)) s = rest;
    else if (Object.hasOwn(WRAPPERS, b)) s = unwrap(b, rest);
    else if (b === 'git') { const r = gitSub(rest); s = r ? `git ${r}` : 'git'; }
    else if (EXES.has(b)) s = rest ? `${b} ${rest}` : b;
  }
  return s;
}

// Split on shell operators and on subshell, group and substitution boundaries; the `$` of `$(` and the backtick stay on the left so `git push origin $(...)` still fails the literal-arguments rule.
export const segments = (cmd) => cmd.replace(/\$\(/g, '$\n(').replace(/`/g, '`\n').split(/&&|\|\||;|\||&|\n|\(|\)|\{\s|\s\}/).map((s) => normalize(s.trim())).filter(Boolean);

export function deny(reason, hookEventName = 'PreToolUse') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}

export function record(root, entry) {
  try {
    const dir = join(gitDir(root), 'harness');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

