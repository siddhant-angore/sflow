import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = { protectedBranches: ['main', 'master'], gate: [], allowMerge: false, dod: [] };
export const PLACEHOLDER = 'replace with the project checks';

export function readEvent() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; }
}

// Replace refs (refs/replace/) can swap any object git reads, including the commit and file the policy comes from, so they are off for every call.
// Grafts (.git/info/grafts) rewrite parents the same way, and git 2.47 still honours them under --no-replace-objects, so only GIT_GRAFT_FILE turns them off.
// core.fsmonitor=false: a configured fsmonitor hook script would otherwise run inside the hook on `git status`/`diff`.
export const NO_REPLACE_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
// <git dir>/<this>/<head> records that the gate passed for head. Versioned: a change that makes the gate stricter gets a new name, so a head that passed the weaker gate is checked again.
export const GATE_RECORD_DIR = 'harness-gate-v2';
export function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: NO_REPLACE_ENV }).toString().trim();
}

// The work tree root; failing that (cwd inside .git, or core.bare=true) the git dir itself, flagged noWorkTree, so the repo stays readable
// (show-ref, show, symbolic-ref work from a git dir). null only when git can't read a repository at all.
export function repoRoot(cwd = process.cwd()) {
  try { return { root: git(cwd, 'rev-parse', '--show-toplevel'), noWorkTree: false }; } catch {}
  try { return { root: git(cwd, 'rev-parse', '--absolute-git-dir'), noWorkTree: true }; } catch { return null; }
}

// Full ref names throughout: `origin/<b>` would resolve refs/tags/origin/<b> or refs/heads/origin/<b> first, and an agent can create both.
// Even `refs/remotes/origin/<b>` falls back to refs/tags/ and refs/heads/ of that name when the remote ref is missing (rev-parse DWIM),
// so every revision handed to git is the sha that `show-ref --verify` (exact ref, no fallback) returned.
const REMOTE = 'refs/remotes/origin/';
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const plausible = (b) => typeof b === 'string' && /^[A-Za-z0-9._+@\/-]+$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock');
export const remoteSha = (root, b) => {
  if (!plausible(b)) return null;
  try { const sha = git(root, 'show-ref', '--verify', '--hash', `${REMOTE}${b}`); return SHA.test(sha) ? sha : null; } catch { return null; }
};
export const remoteDefault = (root) => {
  try {
    const r = git(root, 'symbolic-ref', `${REMOTE}HEAD`);
    const target = r.startsWith(REMOTE) ? r.slice(REMOTE.length) : '';
    return target && remoteSha(root, target) ? target : null;
  } catch { return null; }
};
export const baseCandidates = (root) => [...new Set([remoteDefault(root), 'main', 'master'].filter(Boolean))];

// The policy is the .harness.json committed on origin's base branch: origin/HEAD's branch, then main, then master.
// The working tree is never read as policy, so an agent edit changes nothing. With no committed policy the config fails
// closed: strict defaults (merges denied, no gate, no Stop items) and present is false.
// SID-82/83: "no .harness.json on this candidate" falls through to the next candidate (as always). A file that EXISTS but cannot be used
// (over POLICY_MAX, unreadable, not valid JSON, not a JSON object) is broken: that candidate is the policy, nothing falls through (the next
// candidate may be permissive, and skipping the gate silently is the same hole), and the result is strict defaults + broken:{ base, reason }, never a throw; pre-bash then denies every command (fail-closed, as a throw did).
export const POLICY_MAX = 1 << 20; // 1 MB; git() buffers a blob in memory with the default maxBuffer
export function config(cwd = process.cwd()) {
  const found = repoRoot(cwd);
  if (!found) return { ...DEFAULTS, root: null, present: false, candidates: [], unreadable: true };
  const { root, noWorkTree } = found;
  const candidates = baseCandidates(root);
  let text = null, source = null, base = null, baseSha = null, broken = null;
  for (const b of candidates) {
    const sha = remoteSha(root, b);
    if (!sha) continue;
    let size;
    try { size = Number(git(root, 'cat-file', '-s', `${sha}:.harness.json`)); } catch { continue; } // no such file here (or no such tree): next candidate
    source = `origin/${b}`; base = b; baseSha = sha;
    if (!Number.isInteger(size) || size < 0) broken = { base: b, reason: `could not be read (unexpected size ${JSON.stringify(size)})` };
    else if (size > POLICY_MAX) broken = { base: b, reason: `is over 1 MB (${size} bytes)` };
    else try { text = git(root, 'show', `${sha}:.harness.json`); } catch (e) { broken = { base: b, reason: `could not be read (${e.message.split('\n')[0]})` }; }
    break;
  }
  let parsed = null;
  if (text !== null) {
    try { parsed = JSON.parse(text); } catch (e) { broken = { base, reason: `is not valid JSON (${e.message})` }; }
    if (!broken && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) broken = { base, reason: `is not valid JSON for a policy (it must be an object, not ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`})` };
  }
  if (broken) return { ...DEFAULTS, protectedBranches: [...new Set([...DEFAULTS.protectedBranches, broken.base].filter(Boolean))], allowMerge: false, gate: [], dod: [], root, noWorkTree, present: false, broken, source, base, baseSha, candidates };
  if (text === null) {
    const head = remoteDefault(root);
    return { ...DEFAULTS, protectedBranches: [...new Set([...DEFAULTS.protectedBranches, head].filter(Boolean))], allowMerge: false, gate: [], dod: [], root, noWorkTree, present: false, source: null, base: head ?? 'main', baseSha: remoteSha(root, head ?? 'main'), candidates, ignoredLocal: existsSync(join(root, '.harness.json')) };
  }
  // A non-array protectedBranches is dropped. The base branch must itself be protected, or an agent could push a new policy there; [] (solo repo) is kept.
  let protectedBranches = Array.isArray(parsed.protectedBranches) ? parsed.protectedBranches : DEFAULTS.protectedBranches;
  if (protectedBranches.length && !protectedBranches.includes(base)) protectedBranches = [...protectedBranches, base];
  return { ...DEFAULTS, ...parsed, protectedBranches, root, noWorkTree, present: true, source, base, baseSha, candidates };
}

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADOPT = (base) => ` The working-tree .harness.json is NOT trusted until it is on origin/${base}: a human commits it on a branch (start from ${join(pluginRoot, 'templates', 'harness.json')}), opens a PR, merges it into ${base}, then run git fetch origin.`;

// One line saying which policy is in force, for deny messages.
export const policyNote = (cfg) => policyLine(cfg) + (cfg.noWorkTree ? ` (no work tree: git dir ${cfg.root})` : '');
const policyLine = (cfg) => cfg.unreadable
  ? 'policy: git could not read a repository here (rev-parse failed), so strict defaults apply: protected main, master; merges denied. If this is a repository, check its config (core.bare, core.repositoryformatversion, core.worktree, include.path).'
  : cfg.broken
  ? brokenNote(cfg)
  : cfg.present
  ? `policy: .harness.json on origin/${cfg.base}`
  : `policy: none committed on origin (checked ${cfg.candidates.map((b) => `origin/${b}`).join(', ')}); strict defaults, protected: ${cfg.protectedBranches.join(', ')}, merges denied.${cfg.ignoredLocal ? ADOPT(cfg.base) : ''}`;
// SID-82/83: the committed policy exists but is unusable. Strict defaults hold until a human fixes it on the base branch.
export const brokenNote = (cfg) => `policy: the .harness.json on origin/${cfg.broken.base} ${cfg.broken.reason}; strict defaults apply (protected: ${cfg.protectedBranches.join(', ')}, merges denied) until a human fixes it on ${cfg.broken.base}`;
export const ignoredNote = (cfg) => `The working-tree .harness.json is ignored: no policy is committed on origin (checked ${cfg.candidates.map((b) => `origin/${b}`).join(', ')}), so strict defaults apply (protected: ${cfg.protectedBranches.join(', ')}, merges denied, no gate).${ADOPT(cfg.base)}`;

// The policy files no agent may write: the harness policy and Claude Code's own permissions. Matched by "path ends with", case-insensitively (macOS).
export const POLICY_FILES = ['.harness.json', '.claude/settings.json', '.claude/settings.local.json'];
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/(\.\/)+/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
export const isPolicyPath = (p) => { const n = norm(p); return POLICY_FILES.some((f) => n === f || n.endsWith('/' + f)); };
// SID-162: the file tools (Edit/Write/MultiEdit/NotebookEdit) must not write where git looks for hooks or config, the same rule the shell guard applies.
// Checked on the path as given, on every symlink hop (a dangling link is followed to where it would write) and on the final path, by name (.git/hooks,
// .git/sflow-hooks, a linked worktree's or a submodule's hooks, .git/config*, .git/info/, ~/.gitconfig) and against the real dirs: <git common dir>/hooks,
// /sflow-hooks, /info, config* in the common and per-worktree git dir, and every core.hooksPath value set locally, globally or system-wide. A file with
// more than one link whose dev/inode is a hook or config file is that file (hardlink). Every error fails closed (throws; the caller denies).
export const HOOK_FILE_DENY = 'writing into a hooks directory installs code git runs automatically; ask the user, or use the harness hook setup';
export const GIT_FILE_DENY = 'writing a git config or .git/info file changes what git runs (hooks path, aliases, filters, sparse checkout); ask the user';
const HOOK_FILE_RE = /(?:^|\/)\.git\/(?:modules\/.+\/|worktrees\/[^\/]+\/)?(?:sflow-)?hooks(?:\/|$)/i;
const GIT_FILE_RE = /(?:^|\/)\.git\/(?:modules\/.+\/|worktrees\/[^\/]+\/)?(?:info(?:\/|$)|config[^\/]*$)/i;
export const CASE_FOLD = process.platform === 'darwin' || process.platform === 'win32'; // default file systems there are case-insensitive
export const pathWithin = (p, dir, fold = CASE_FOLD) => {
  if (fold) { p = p.toLowerCase(); dir = dir.toLowerCase(); }
  const r = relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
};
// Where a write to p lands: symlinks are followed, dangling ones too (the write creates the link's target). Every hop goes into trail.
export function chase(p, trail = [], hops = 0) {
  if (hops > 40) throw new Error(`too many symlinks at ${p}`);
  try { const r = realpathSync(p); trail.push(r); return r; } catch {}
  let st = null;
  try { st = lstatSync(p); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  if (st?.isSymbolicLink()) { const t = resolve(dirname(p), readlinkSync(p)); trail.push(t); return chase(t, trail, hops + 1); }
  if (st) throw new Error(`cannot resolve ${p}`); // exists, yet realpath failed (permissions)
  const up = dirname(p); if (up === p) return p;
  const r = join(chase(up, trail, hops), basename(p)); trail.push(r); return r;
}
// git that tells "no repository" (null) from a failure (throws): a missing binary, a safe.directory refusal or a broken config all throw.
function gitAt(at, args, unset = []) {
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', at, ...args], { encoding: 'utf8', env: NO_REPLACE_ENV, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  if (r.error) throw r.error;
  if (r.status === 0) return r.stdout.replace(/\n$/, '');
  if (unset.includes(r.status)) return null;
  if (r.status === 128 && /not a git repository/i.test(r.stderr) && !/dubious ownership|safe\.directory/i.test(r.stderr)) return null;
  throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.trim().split('\n')[0]}`);
}
const home = () => process.env.HOME || homedir();
const hookDir = (hp, top) => (isAbsolute(hp) ? hp : /^~(\/|$)/.test(hp) ? join(home(), hp.slice(2)) : top ? resolve(top, hp) : null);
const lines = (x) => (x ? x.split('\n').filter(Boolean) : []);
// The protected places for one directory's repository (none outside a repository) plus the global and system ones.
function protectedFor(at, out) {
  const rel = gitAt(at, ['rev-parse', '--git-common-dir']);
  if (rel) {
    const common = resolve(at, rel);
    const gd = gitAt(at, ['rev-parse', '--absolute-git-dir']), top = gitAt(at, ['rev-parse', '--show-toplevel'], [128]);
    out.trees.push(join(common, 'hooks'), join(common, 'sflow-hooks'), join(gd, 'hooks')); out.info.push(join(common, 'info'), join(gd, 'info'));
    out.cfgDirs.push(common, gd);
    for (const hp of lines(gitAt(at, ['config', '--get-all', 'core.hooksPath'], [1]))) { const d = hookDir(hp, top ?? at); if (d) out.trees.push(d); }
    out.tops.push(top ?? at);
  }
  return out;
}
function globalProtected(at, out) {
  for (const scope of ['--global', '--system']) for (const hp of lines(gitAt(at, ['config', scope, '--get-all', 'core.hooksPath'], [1]))) {
    if (isAbsolute(hp) || /^~(\/|$)/.test(hp)) out.trees.push(hookDir(hp));
    else out.relHooks.push(hp); // relative to whichever repository runs the hooks
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(home(), '.config');
  out.files.push(join(home(), '.gitconfig'), join(xdg, 'git', 'config'), ...(process.env.GIT_CONFIG_GLOBAL ? [resolve(at, process.env.GIT_CONFIG_GLOBAL)] : []));
  return out;
}
const existingDir = (p) => { let at = p; while (!existsSync(at) && dirname(at) !== at) at = dirname(at); return statSync(at).isDirectory() ? at : dirname(at); };
function inodes(paths, limit = 5000) { // dev:ino of every file under the protected trees and of the config files (hardlink check)
  const ids = new Set(); let n = 0;
  const walk = (p) => {
    let st; try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
    if (++n > limit) throw new Error('too many files under the hooks dirs to check for hardlinks');
    if (st.isDirectory()) { for (const x of readdirSync(p)) walk(join(p, x)); } else ids.add(`${st.dev}:${st.ino}`);
  };
  paths.forEach(walk); return ids;
}
// By name only, on the path and every symlink hop: needs no git. The shell guard falls back to it when git can't read the repository.
export function hookFileName(file, cwd = process.cwd()) {
  if (!file) return null;
  const abs = resolve(cwd, String(file).replace(/\\/g, '/')), trail = [abs], real = chase(abs, trail);
  const seen = [...new Set(trail)], name = (re) => seen.some((p) => re.test(p.replace(/\\/g, '/')));
  return { why: name(HOOK_FILE_RE) ? HOOK_FILE_DENY : name(GIT_FILE_RE) ? GIT_FILE_DENY : null, real, seen };
}
export function hookFileReason(file, cwd = process.cwd()) {
  if (!file) return null;
  const { why, real, seen } = hookFileName(file, cwd);
  if (why) return why;
  const out = { trees: [], info: [], cfgDirs: [], files: [], relHooks: [], tops: [] }, at = existingDir(real);
  protectedFor(at, out);
  const here = resolve(cwd); if (existsSync(here) && statSync(here).isDirectory() && here !== at) protectedFor(here, out);
  globalProtected(at, out);
  for (const hp of out.relHooks) for (const top of out.tops) out.trees.push(resolve(top, hp));
  const both = (xs) => xs.flatMap((d) => [d, chase(d)]), trees = both(out.trees), info = both(out.info), files = both(out.files).filter((f) => { try { return !statSync(f).isCharacterDevice(); } catch { return true; } }), cfgDirs = both(out.cfgDirs);
  if (seen.some((p) => trees.some((d) => pathWithin(p, d)))) return HOOK_FILE_DENY;
  if (seen.some((p) => info.some((d) => pathWithin(p, d)))) return GIT_FILE_DENY;
  const fold = (x) => (CASE_FOLD ? x.toLowerCase() : x);
  if (seen.some((p) => files.some((f) => fold(f) === fold(p)) || (/^config/i.test(basename(p)) && cfgDirs.some((d) => fold(d) === fold(dirname(p)))))) return GIT_FILE_DENY;
  let st = null; try { st = statSync(real); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st?.isFile() && st.nlink > 1) { const ids = inodes([...trees, ...info, ...files, ...cfgDirs.flatMap((d) => readdirSync(d).filter((x) => /^config/i.test(x)).map((x) => join(d, x)))]); if (ids.has(`${st.dev}:${st.ino}`)) return HOOK_FILE_DENY; }
  return null;
}
// A glob token (* ? [ ]) that could expand to a policy path, e.g. .harness*, .claude/*, .claude/settings*.json. A * or ? at the start of a segment does not match a leading dot, as in the shell.
const globRe = (g) => {
  let re = '', start = true;
  for (let i = 0; i < g.length; i++) {
    const c = g[i], dot = start ? '(?!\\.)' : '';
    if (c === '*') re += dot + '[^/]*';
    else if (c === '?') re += dot + '[^/]';
    else if (c === '[' && g.indexOf(']', i + 2) > 0) { const j = g.indexOf(']', i + 2); re += '[' + g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; }
    else re += c.replace(/[.+^${}()|\\\]\[]/g, '\\$&');
    start = c === '/';
  }
  return new RegExp('^' + re + '$');
};
export const policyGlobHit = (p) => {
  const n = norm(p);
  if (!/[*?[]/.test(n)) return false;
  const segs = n.split('/');
  return segs.some((_, i) => { try { const re = globRe(segs.slice(i).join('/')); return POLICY_FILES.some((f) => re.test(f)); } catch { return false; } });
};
const policyText = (p) => /\.claude\/[^/]*$|settings[^/]*$/i.test(String(p))
  ? ' holds Claude Code permissions; agents do not write it from the shell or the file tools. Leave it unchanged and ask the human to make the change (say which setting and why). Reading it is fine.'
  : ` is the harness policy; agents do not write it from the shell or the file tools. Leave it unchanged. To propose a policy, put the JSON in your PR description (start from ${join(pluginRoot, 'templates', 'harness.json')}); a human commits it on a branch, merges it into the base branch on origin, then runs git fetch origin. Reading it (cat, jq, git show) is fine.`;
export const policyDeny = (p) => p + policyText(p);

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
export { WRAPPERS, take, unwrap };

// Drop git's global options (everything starting with - before the subcommand, plus the argument of those that take one).
function gitSub(rest) {
  for (;;) {
    const [o, r] = take(rest);
    if (!o?.startsWith('-')) return rest;
    rest = GIT_ARG.has(o) ? take(r)[1] : r;
  }
}

// End index of the '...', "..." or $'...' that opens at s[i] (backslash escapes inside "..." and $'...' only, so $'\'' is one word); s.length + 1 if it never closes.
const quoteEnd = (s, i) => { const a = +(s[i] === '$'), q = s[i + a], esc = a || q === '"'; for (let j = i + 1 + a; j < s.length; j++) { if (s[j] === '\\' && esc) j++; else if (s[j] === q) return j + 1; } return s.length + 1; };

// Drop shell redirections (`2>&1`, `&>f`, `>f`, `> f`, `<<EOF`, `HEAD>f`) and their targets, so none can hide or reorder arguments. Quoted text is untouched.
const REDIR = /^(?:&>>?|>>|>\||>&|<&|<<<|<<-?|<>|>|<)/;
function stripRedirs(s) {
  const out = []; let cur = '', drop = false;
  const flush = () => { if (cur) { if (drop) drop = false; else out.push(cur); cur = ''; } };
  for (let i = 0; i < s.length;) {
    const c = s[i], op = REDIR.exec(s.slice(i))?.[0];
    if (c === '\\') { cur += s.slice(i, i + 2); i += 2; }
    else if (c === '"' || c === "'" || (c === '$' && s[i + 1] === "'")) { const e = quoteEnd(s, i); cur += s.slice(i, e); i = e; }
    else if (/\s/.test(c)) { flush(); i++; }
    else if (op) { if (/^\d+$/.test(cur)) cur = ''; else flush(); drop = true; i += op.length; }
    else { cur += c; i++; }
  }
  flush();
  return out.join(' ');
}

export function normalize(seg, keywords = true) {
  let s = stripRedirs(seg.trim());
  for (let prev = null; prev !== s;) {
    prev = s;
    const [t, rest] = take(s);
    if (t === null) break;
    const b = /^\\?(?:[^\s"'=\\]*\/)?([\w.+-]+)$/.exec(t)?.[1] ?? t;
    if ((keywords && KEYWORDS.has(t)) || /^[A-Za-z_]\w*\+?=/.test(t)) s = rest;
    else if (Object.hasOwn(WRAPPERS, b)) s = unwrap(b, rest);
    else if (b === 'git') { const r = gitSub(rest); s = r ? `git ${r}` : 'git'; }
    else if (EXES.has(b)) s = rest ? `${b} ${rest}` : b;
    s = stripRedirs(s);
  }
  return s;
}

// The word after << or <<-: [delimiter, quoted]. A quoted word (any of ' " \) means the body expands nothing. null when no word follows.
function hereWord(s, j) {
  let d = '', quoted = false; const j0 = j;
  for (; j < s.length && !/[\s;&|()<>]/.test(s[j]); j++) {
    if (s[j] === '\\') { quoted = true; d += s[++j] ?? ''; }
    else if (s[j] === "'" || s[j] === '"') { quoted = true; const e = quoteEnd(s, j); d += s.slice(j + 1, e - 1).replace(/\\(.)/g, s[j] === '"' ? '$1' : '\\$1'); j = e - 1; }
    else if (!(s[j] === '$' && s[j + 1] === "'")) d += s[j];
  }
  return j > j0 ? [d, quoted] : null;
}

// Split on shell operators (&& || ; | |& newline, a background & but not the & of 2>&1 or &>), on ( ) and on a word-start `{ ` or ` }`, but only outside quotes. The `$` of `$(` and the backtick stay on the left so `git push origin $(...)` still fails the literal-arguments rule.
// Inside "..." a `$(` or backtick still runs a command, so its contents are split out; the rest of the string is text and dropped. A # comment (word-start # to end of line) is never run: it is dropped, so a quote in it opens nothing.
// A heredoc body (after `<<WORD`, from the next newline to the line WORD) is not shell text: it is read raw into docs, owned by the segment holding the `<<`. open: a quote, $'..', $(, backtick or heredoc never closed.
function split(cmd) {
  const out = [], docs = [], pending = [], st = [{ close: null, depth: 0 }]; // frames: a command context, or a "..." string ({ dq })
  let buf = '', open = false;
  const cut = () => { out.push(buf); buf = ''; };
  const bodies = (i) => { // read the pending heredoc bodies that start after the newline at i; the index of the last char consumed
    let pos = i + 1;
    for (const p of pending.splice(0)) {
      const lines = []; let found = false;
      while (pos <= cmd.length && !found) {
        const e = cmd.indexOf('\n', pos), end = e < 0 ? cmd.length : e, line = cmd.slice(pos, end);
        if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) found = true; else lines.push(line);
        pos = end + 1;
      }
      open ||= !found;
      docs.push({ owner: p.owner, text: lines.join('\n'), quoted: p.quoted });
    }
    return pos - 1;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1], top = st.at(-1);
    if (top.dq) {
      const put = (x) => { if (!top.drop) buf += x; };
      if (c === '\\') { put(cmd.slice(i, i + 2)); i++; }
      else if (c === '"') { st.pop(); if (top.drop) buf = ''; else buf += c; }
      else if (c === '`' || (c === '$' && n === '(')) { put(c); cut(); top.drop = true; st.push(c === '`' ? { close: '`' } : { close: ')', depth: 1 }); if (c === '$') i++; }
      else put(c);
    }
    else if (c === '\\') { buf += cmd.slice(i, i + 2); i++; }
    else if (c === "'" || (c === '$' && n === "'")) { const e = quoteEnd(cmd, i); open ||= e > cmd.length; buf += cmd.slice(i, e); i = e - 1; }
    else if (c === '"') { st.push({ dq: true }); buf += c; }
    else if (c === '`') { buf += c; cut(); if (top.close === '`') st.pop(); else st.push({ close: '`' }); }
    else if (c === '#' && (buf === '' || /\s$/.test(buf))) { const e = cmd.indexOf('\n', i); i = (e < 0 ? cmd.length : e) - 1; }
    else if (c === '<' && n === '<' && cmd[i - 1] !== '<' && cmd[i + 2] !== '<') {
      const strip = cmd[i + 2] === '-'; let j = i + 2 + strip;
      while (/[ \t]/.test(cmd[j] ?? '')) j++;
      const w = hereWord(cmd, j);
      if (w) pending.push({ delim: w[0], quoted: w[1], strip, owner: out.length });
      buf += '<<'; i++;
    }
    else if (c === '\n' && pending.length) { cut(); i = bodies(i); }
    else if (c === '(') { cut(); if (top.close === ')') top.depth++; }
    else if (c === ')') { cut(); if (top.close === ')' && --top.depth === 0) st.pop(); }
    else if ((c === '&' && n === '&') || (c === '|' && (n === '|' || n === '&'))) { cut(); i++; }
    else if (c === ';' || c === '\n' || c === '|' || (c === '&' && n !== '>' && !'<>&|'.includes(cmd[i - 1] ?? ' '))) cut();
    else if ((c === '{' && /\s/.test(n ?? '')) || (c === '}' && /^[\s;&|)]?$/.test(n ?? ''))) { if (buf === '' || /\s$/.test(buf)) cut(); else buf += c; }
    else buf += c;
  }
  cut();
  return { out, docs, open: open || st.length > 1 || pending.length > 0 };
}

// Commands that run a string as a command line (`sh -c P`, `eval P`, `su -c P`, `script -c P`, `flock f -c P`, `watch P`, `ssh host P`): the unquoted payloads.
const unquote = (t) => t.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, d, q) => d?.replace(/\\(.)/g, '$1') ?? q);
const SSH_ARG = new Set([...'bcDEeFIiJLlmOopQRSWw'].map((c) => `-${c}`)), WATCH_ARG = new Set(['-n', '--interval']);
const skipOpts = (r, withArg) => { for (;;) { const [t, a] = take(r); if (!t?.startsWith('-')) return r; r = withArg.has(t) ? take(a)[1] : a; } };
function cArg(r) {
  for (;;) {
    const [t, a] = take(r);
    if (t === null) return [];
    if (/^-[a-zA-Z]*c$/.test(t) || t === '--command') { const [p] = take(a); return p === null ? [] : [unquote(p)]; }
    if (t.startsWith('--command=')) return [unquote(t.slice(10))];
    r = a;
  }
}
// `busybox sh` is `sh`: [word, basename, rest] after skipping the busybox applet prefix.
function head(s) {
  let [h, r] = take(s), b = h?.replace(/^.*\//, '');
  if (b === 'busybox') { [h, r] = take(r); b = h?.replace(/^.*\//, ''); }
  return [h, b, r];
}
const SHELL = /^(?:sh|ash|bash|zsh|dash|ksh|fish)$/;
function payload(s) {
  const [h, b, r] = head(s);
  if (h === 'eval') return [unquote(r)];
  if (b === 'su' || b === 'script' || b === 'flock') return cArg(r);
  if (b === 'watch') { const w = skipOpts(r, WATCH_ARG); return w ? [unquote(w)] : []; }
  if (b === 'ssh') { const c = skipOpts(take(skipOpts(r, SSH_ARG))[1], SSH_ARG); return c ? [unquote(c)] : []; }
  if (!SHELL.test(b ?? '')) return [];
  for (let rest = r;;) {
    const [t, after] = take(rest);
    if (t === null || !/^[-+]/.test(t)) return [];
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) {
      for (rest = after;;) { // `bash -c -- 'P'`, `bash -c -x 'P'`: the string is the first word that is not an option
        const [o, a] = take(rest);
        if (o === '--') { rest = a; break; }
        if (!/^[-+]/.test(o ?? '')) break;
        rest = /^[-+][oO]$/.test(o) ? take(a)[1] : a;
      }
      const [p] = take(rest); return p === null ? [] : [unquote(p)];
    }
    rest = /^[-+][oO]$/.test(t) ? take(after)[1] : after;
  }
}

// A command reads a shell script from stdin: `bash`, `busybox sh`, `ssh host` (not `sh -c`). Heredoc text anywhere in a command that has such a segment may reach it (`cat <<E | sh`), so all its bodies count as commands.
const feedsShell = (n) => { const b = head(n)[1] ?? ''; return (SHELL.test(b) || b === 'ssh') && payload(n).length === 0; };

// The replace-string of the xargs in a raw segment (`-I{}`, `-I %`, `-i`, `--replace[=S]`), or null. normalize() strips xargs, so `xargs -I{} sh -c {}` is only seen as `sh -c {}` there.
function xargsRepl(s) {
  let r = /(?:^|\s)xargs\s+([\s\S]*)$/.exec(s)?.[1], repl = null;
  for (; r !== undefined;) {
    const [t, a] = take(r);
    if (!t?.startsWith('-') || t === '--') return repl;
    r = a;
    if (t === '-I') { const [v, b] = take(a); repl = v && unquote(v); r = b; }
    else if (/^-I./.test(t)) repl = unquote(t.slice(2));
    else if (t === '-i' || t === '--replace') repl = '{}';
    else if (/^-i./.test(t)) repl = unquote(t.slice(2));
    else if (t.startsWith('--replace=')) repl = unquote(t.slice(10));
    else if ((t.length === 2 && WRAPPERS.xargs.includes(t[1])) || LONG_ARG.has(t)) r = take(a)[1];
  }
  return repl;
}
// A shell that reads its SCRIPT from stdin or a process substitution: `sh`, `bash -s`, `ssh host`, `xargs sh -c` (not `bash file.sh`, which reads the file), or `xargs -I{} sh -c {}`, where each input line is the script.
function stdinShell(o) {
  const s = stripRedirs(o.trim()), n = normalize(s), [h, b, r] = head(n);
  if (h === 'source' || h === '.') return /^(?:\/dev\/(?:stdin|fd\/0))?$/.test(r.trim()); // `source <(cmd)` (the `<(` is cut off), `| source /dev/stdin`; not `source file`
  if (feedsShell(n)) { if (b === 'ssh') return true; for (let [t, a] = take(r); t !== null; [t, a] = take(a)) if (!/^[-+]/.test(t)) return false; return true; }
  const p = payload(n)[0]?.trim();
  if (p === undefined) return false;
  if (/[$`]$/.test(p)) return true; // `sh -c "$(cmd)"`, `eval \`cmd\``: split() cuts the segment right at the substitution, so the payload ends in `$` or a backtick; the script is cmd's output
  // under xargs the input reaches the script as the replace-string or as positional arguments ($@ $* $0 $1 ..)
  return /(?:^|\s)xargs\s/.test(s) && (p.includes('{}') || (xargsRepl(s) !== null && p.includes(xargsRepl(s))) || /\$(?:[@*0-9]|\{[@*0-9])/.test(p));
}
// What a stdin shell may be fed: every quoted string in the line, and the argument text of each other segment (`echo git reset --hard | sh`), with echo -e / printf escapes decoded.
const esc = (t) => t.replace(/\\([\s\S])/g, (_, c) => (c === 'n' || c === 'r' ? '\n' : c === 't' ? '\t' : c));
const fedText = (line, out) => [
  ...[...line.matchAll(/\$'((?:\\[\s\S]|[^'\\])*)'|'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"/g)].map((m) => esc(m[1] ?? m[2] ?? m[3])),
  ...out.filter((o) => !stdinShell(o)).map((o) => esc(unquote(take(stripRedirs(o.trim()))[1]))),
];

// Quoted text is only data when nothing in the command can execute it. `echo 'x; git push -f origin main' | sh` and `... > f.sh && bash f.sh` run it, and `git -c core.pager='...' log` or `GIT_PAGER='...' git log` execute it,
// so quotes are honoured only when every segment (judged raw, after redirections) starts with a command that never runs its arguments; anything else also gets the quote-blind scan.
const NON_EXEC = /^(?:(?:echo|printf|grep|cat|rg|cd|pwd|ls|true|false|:|test|\[|head|tail|wc|sort|uniq|cut|tr|mkdir|touch|tee|sleep)|git\s+(?:add|commit|status|log|diff|show|push|fetch|switch|checkout|restore|branch|rm|mv|tag|stash|reset|clean|rev-parse)|gh\s+(?:pr\s+(?:create|edit|comment|view)|issue\s+(?:create|comment|view)))(?:\s|$)/;
// Options whose value is executed (git runs it via a shell; sort runs a program), matched by prefix (--up, --rec, --e, --co) because both accept unique abbreviations. `--e` is a unique prefix of push's --exec; --u, --up, --r and --re are ambiguous in git (git refuses them), so they are safe and are not tested. Tested on a de-quoted copy, since bash joins `--u''pl=`, `-"-"exe`, `$'--rec'eive-p=`.
// GNU sort accepts `--co=` for --compress-program. A dash-word containing `$`, a backtick, or a brace or glob character can expand to anything, so it is never trusted: bash brace expansion and globs can produce or rename an option (`--{e,e}=`, `-{-,-}e=`, `--u{p,p}l=`, `--[e]=`).
// Brace expansion can also CREATE a dash-word from a word that does not start with a dash (`{--e,--e}='payload'` expands to `--e='payload' --e='payload'`), so a word with a brace list or range is never trusted either. Harmless hits such as --recurse-submodules just fall back to the quote-blind scan, as on main.
const RUNS_ARG = /(?:^|\s)--(?:up|rec|e|co)/;
const EXPANDS_OPT = /(?:^|\s)['"\\$]*-\S*[$`{[*?]/;
const BRACE_WORD = /(?:^|\s)[^\s'"]*\{[^\s}]*(?:,|\.\.)[^\s}]*\}/;
const nonExec = (raw) => { const s = stripRedirs(raw.trim()); return !s || (NON_EXEC.test(s) && !BRACE_WORD.test(s) && !(/^rg\s/.test(s) && /\s--pre/.test(s)) && !RUNS_ARG.test(s.replace(/\$?['"]|\\/g, '')) && !EXPANDS_OPT.test(s)); };

// Shell writes into a git directory: [{ path, kind }], kind config | hooks | info | modules. Git runs what such files hold (core.pager, aliases, hooks), so text quoted in a command that writes them is not data.
// Works on a de-quoted copy: quoted characters are hidden (private-use code points) so a quoted `;`, `>` or space never splits or redirects. Reads (cat, grep, cp from, sed without -i) are not writes.
const KIND_RES = [['hooks', /(?:^|\/)[^\/\s]*\.git\/(?:modules\/.+\/|worktrees\/[^\/]+\/)?(?:sflow-)?hooks(?:\/|$)/], ['modules', /(?:^|\/)[^\/\s]*\.git\/modules\/.+\/config$/], ['config', /(?:^|\/)[^\/\s]*\.git\/(?:config(?:\.worktree)?|worktrees\/[^\/]+\/config\.worktree)$/], ['info', /(?:^|\/)[^\/\s]*\.git\/info\//], ['config', /(?:^|\/)\.gitconfig$|(?:^|\/)\.config\/git\/config$|^\$\{?XDG_CONFIG_HOME\}?\/git\/config$|^\/etc\/gitconfig$/]]; // the last is global/system config: ~/.gitconfig, ~/.config/git/config, $XDG_CONFIG_HOME/git/config, /etc/gitconfig
const hide = (c) => (c.charCodeAt(0) < 256 ? String.fromCharCode(0xE000 + c.charCodeAt(0)) : c), show = (s) => s.replace(/[\uE000-\uE0FF]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xE000));
function dequote(s) { // q: s single, d double, a $'..'
  let out = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === 's') { if (c === "'") q = null; else out += hide(c); }
    else if (q) { if (c === '\\' && i + 1 < s.length) out += hide(s[++i]); else if (c === (q === 'd' ? '"' : "'")) q = null; else out += hide(c); }
    else if (c === '\\') { if (++i < s.length) out += hide(s[i]); }
    else if (c === "'") q = 's';
    else if (c === '"') q = 'd';
    else if (c === '$' && (s[i + 1] === "'" || s[i + 1] === '"')) q = s[++i] === "'" ? 'a' : 'd';
    else out += c;
  }
  return out;
}
const GIT_SEP = /&&|\|\||;|\n|`|[()]|(?<!>)\||(?<![<>&\d])&(?![>&])/, GIT_REDIR = /(?<![-=])\d*(?:&>>?|>>|>\||<>|>&|>)\s*([^\s<>|&;()]+)/g;
const GIT_CD = /(?:^|\/)[^\/\s]*\.git(?:\/(?:hooks|sflow-hooks|info|modules\/.+))?\/*$|(?:^|\/)\.husky\/*$/, GIT_CMDS = new Set(['sort', 'uniq', 'git', 'tee', 'cp', 'mv', 'ln', 'install', 'sed', 'perl', 'dd', 'truncate']);
const GIT_WRAP = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'ionice', 'xargs']), GIT_KW = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const NO_FILE = /^\/dev\/(?:null|stdout|stderr|tty)$/;
// SID-155: removing, moving or un-executing a git hook turns off the guards that run outside Claude (SID-147). The hooks dirs: .git/hooks (also a
// submodule's or a linked worktree's), .git/sflow-hooks (SID-147's core.hooksPath stubs) and .husky. A glob that could match one fails closed.
const RM_CMDS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'find', 'chmod']);
const HOOK_DIR = /(?:^|\/)[^\/\s]*\.git\/(?:modules\/.+\/|worktrees\/[^\/]+\/)?(?:sflow-)?hooks(?:\/|$)|(?:^|\/)\.husky(?:\/|$)/;
const globPart = (pat, name) => { // one path component; a leading dot is matched only by a literal dot, as in the shell
  if (!/[*?[]/.test(pat)) return pat === name;
  if (name.startsWith('.') && !pat.startsWith('.')) return false;
  try { return new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')}$`).test(name); } catch { return true; } // an unparseable class fails closed
};
const hookGlob = (p) => {
  if (!/[*?[]/.test(p)) return false;
  const c = p.split('/');
  return c.some((x, i) => globPart(x, '.husky') || (globPart(x, '.git') && i + 1 < c.length && ['hooks', 'sflow-hooks'].some((h) => globPart(c[i + 1], h))));
};
// Output files named by sort (-o FILE, -oFILE, clusters like -uo FILE, --output and its unique abbreviations) and uniq (second operand). Both write the file, so they count as file writes.
export function sortOut(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const lm = /^--(o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?)(?:=(.*))?$/.exec(a);
    if (lm) { if (lm[2] !== undefined) out.push(lm[2]); else if (args[i + 1] !== undefined) out.push(args[++i]); continue; }
    if (/^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (c === 'o') { const rest = a.slice(k + 1); if (rest) out.push(rest); else if (args[i + 1] !== undefined) out.push(args[++i]); break; }
        if ('ktST'.includes(c)) { if (k + 1 >= a.length) i++; break; }
      }
    }
  }
  return out;
}
export function uniqOut(args) {
  const ops = []; let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest || a === '-' || !a.startsWith('-')) { ops.push(a); continue; }
    if (a === '--') { rest = true; continue; }
    if (/^(?:-[fsw]|--skip-fields|--skip-chars|--check-chars)$/.test(a)) i++;
  }
  return ops.slice(1, 2);
}
// One pass over one string: { writes: git-dir/config writes as [{ path, kind }], files: every file it writes }. Commands inside $( ) in a quoted string are hidden here; scanAll adds them.
function scan(cmd) {
  const text = cmd.replace(/\\\n/g, '').replace(/\$\(\s*git\s+rev-parse\s+--git-path\s+hooks\s*\)|`\s*git\s+rev-parse\s+--git-path\s+hooks\s*`/g, '.git/hooks').replace(/\$\{?GIT_DIR\}?|\$\(\s*git\s+rev-parse\s+--git-common-dir\s*\)|`\s*git\s+rev-parse\s+--git-common-dir\s*`|\$\(\s*git\s+rev-parse\s+--(?:absolute-)?git-dir\s*\)|`\s*git\s+rev-parse\s+--(?:absolute-)?git-dir\s*`/g, '.git'); // $GIT_DIR and rev-parse --git-dir name a git dir
  const dq = dequote(text), base = (x) => x.replace(/^.*\//, '');
  const dirs = [...show(dq).matchAll(/(?:^|[\s;&|(`])(?:GIT_DIR=|--git-dir[=\s]\s*)([^\s;&|)`]+)/g)].map((m) => m[1].replace(/\/+$/, '')).filter(Boolean); // GIT_DIR=X, --git-dir X: X/config is a git config
  const writes = [], files = []; let cwd = null;
  const hit = (t) => {
    t = show(t).replace(/\/{2,}/g, '/').replace(/\/(?:\.\/)+/g, '/');
    const d = dirs.find((x) => t.startsWith(`${x}/`)); if (d) t = `.git/${t.slice(d.length + 1)}`;
    for (const p of cwd && !/^[\/~$]/.test(t) ? [t, `${cwd}/${t.replace(/^\.\//, '')}`] : [t]) { const kind = KIND_RES.find(([, re]) => re.test(p))?.[0]; if (kind) return void writes.push({ path: p, kind }); }
  };
  const put = (t) => { if (!NO_FILE.test(show(t))) files.push(show(t)); hit(t); };
  const unhook = (t) => { // SID-155: t is removed, moved away or has its mode changed
    t = show(t).replace(/\/{2,}/g, '/').replace(/\/(?:\.\/)+/g, '/').replace(/\/+$/, '');
    const d = dirs.find((x) => t === x || t.startsWith(`${x}/`)); if (d) t = `.git${t.slice(d.length)}`;
    for (const p of cwd && !/^[\/~$]/.test(t) ? [t, `${cwd}/${t.replace(/^\.\//, '')}`] : [t]) if (HOOK_DIR.test(p) || hookGlob(p)) return void writes.push({ path: p, kind: 'unhook' });
  };
  for (const seg of dq.split(GIT_SEP)) {
    for (const m of seg.matchAll(GIT_REDIR)) if (!(/&/.test(m[0].slice(0, m[0].length - m[1].length)) && /^(?:\d+-?|-)$/.test(m[1]))) put(m[1]); // `2>&1` duplicates a descriptor, it writes no file
    const w = seg.replace(GIT_REDIR, ' ').split(/\s+/).filter(Boolean).map(show);
    while (w.length && (/^\w+=/.test(w[0]) || GIT_KW.has(w[0]))) w.shift();
    if (!w.length) continue;
    if (base(w[0]) === 'cd' || base(w[0]) === 'pushd') { const d = w.slice(1).find((x) => !x.startsWith('-')); cwd = d && GIT_CD.test(d) ? d.replace(/\/+$/, '') : null; continue; }
    const rmAt = RM_CMDS.has(base(w[0])) ? 0 : GIT_WRAP.has(base(w[0])) ? w.findIndex((x, j) => j > 0 && RM_CMDS.has(base(x))) : -1;
    if (rmAt >= 0) {
      const rname = base(w[rmAt]), rargs = w.slice(rmAt + 1);
      if (rname === 'find') { // find P... -delete / -exec ...: the start paths go
        const starts = []; for (const a of rargs) { if (/^[-(!]/.test(a)) break; starts.push(a); }
        if (rargs.some((a) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(a))) (starts.length ? starts : ['.']).forEach(unhook);
      } else if (rname === 'chmod') { const m = rargs.findIndex((a) => !/^-(?:[Rcfv]+|-[a-z-]+(?:=.*)?)$/.test(a)); rargs.slice(m + 1).forEach(unhook); } // the first non-option word is the mode (-x included)
      else rargs.filter((a) => !a.startsWith('-')).forEach(unhook);
      // No `continue`: a wrapper line (`env tee .git/hooks/x rm`) still gets the GIT_CMDS write scan below. rm/unlink/... are not GIT_CMDS, so nothing double-counts.
    }
    const at = GIT_CMDS.has(base(w[0])) ? 0 : GIT_WRAP.has(base(w[0])) ? w.findIndex((x, j) => j > 0 && GIT_CMDS.has(base(x))) : -1;
    if (at < 0) continue;
    const name = base(w[at]), args = w.slice(at + 1), operands = args.filter((a) => !a.startsWith('-'));
    if (name === 'sort') sortOut(args).forEach(put);
    else if (name === 'uniq') uniqOut(args).forEach(put);
    else if (name === 'git') args.forEach((a, j) => { if (a === '--output' && args[j + 1]) put(args[j + 1]); else if (a.startsWith('--output=')) put(a.slice(9)); });
    else if (name === 'tee' || name === 'truncate') operands.forEach(put);
    else if (name === 'dd') args.filter((a) => a.startsWith('of=')).forEach((a) => put(a.slice(3)));
    else if (name === 'sed' || name === 'perl') { if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) operands.forEach(put); }
    else { // cp mv ln install: the destination is -t DIR or the last operand
      const j = args.findIndex((a) => /^-[a-zA-Z]*t$/.test(a) || a === '--target-directory'), eq = args.find((a) => a.startsWith('--target-directory='));
      const dest = eq ? eq.slice(19) : j >= 0 ? args[j + 1] : operands.at(-1);
      if (dest) put(dest);
      if (name === 'ln') operands.filter((x) => x !== dest && (j < 0 || x !== args[j + 1])).forEach(hit); // SID-162: a link to or from a hook or git config file (`ln -s .git/hooks/post-commit pc`, `ln .git/hooks/pre-commit hl`) lets a later write or chmod change it
      if (name === 'mv') (eq || j >= 0 ? operands.filter((o) => o !== dest) : operands.slice(0, -1)).forEach(unhook); // SID-155: mv takes its sources away
    }
  }
  return { writes, files };
}
// scan over the command and, recursively, every piece the quote-aware split cuts out of it, so a write inside "$( )" or backticks in a string is seen too.
function scanAll(cmd) {
  const joined = cmd.replace(/\\+\n/g, (m) => ((m.length - 1) % 2 ? m.slice(0, -2) : m)), r = scan(cmd);
  for (const piece of split(joined).out) if (piece !== cmd) { const x = scanAll(piece); r.writes.push(...x.writes); r.files.push(...x.files); }
  return r;
}
export function gitWrites(cmd) {
  const seen = new Set();
  return scanAll(cmd).writes.filter((w) => { const k = `${w.kind} ${w.path}`; return !seen.has(k) && seen.add(k); });
}
// Text written to any file can be executed later (hooks, .husky, scripts, git config), so a line that writes a file loses quote trust in segments().
export const writesFile = (cmd) => scanAll(cmd).files.length > 0;

// Everything that may run. Quote-aware segments (with $( ), backtick, heredoc-body and payload extraction) are always used. Unless quotes are honoured, the text is also split quote-blind on && || ; | newline, as before.
export function segments(cmd) {
  const joined = cmd.replace(/\\+\n/g, (m) => ((m.length - 1) % 2 ? m.slice(0, -2) : m)); // backslash-newline continues the line
  const { out, docs, open } = split(joined), raw = [...out], extra = [];
  let unsure = open;
  const reads = out.some((o) => feedsShell(normalize(o)));
  for (const d of docs) {
    if (!d.quoted) { const x = split(`"${d.text.replace(/\\[\s\S]|"/g, (m) => (m === '"' ? '\\"' : m))}"`); raw.push(...x.out.slice(1)); unsure ||= x.open || x.docs.length > 0; } // an unquoted body still expands $( ) and backticks
    if (reads) extra.push(...segments(d.text));
  }
  if (out.some(stdinShell)) extra.push(...fedText(joined, out).flatMap(segments)); // text piped into a shell (`echo 'git reset --hard' | sh`, `tee >(sh)`, `sh <(echo ..)`, `xargs -I{} sh -c {}`) runs
  const run = (s) => { const n = normalize(s); return n ? [n, ...payload(n).flatMap(segments)] : []; };
  const qa = [...raw.flatMap(run), ...extra];
  if (!unsure && raw.every(nonExec) && !writesFile(joined)) return qa; // a line that writes a file keeps main's quote-blind scan too: what it writes can run later
  const seen = new Set(qa), blind = [];
  // Lines of a heredoc body no shell reads are data, so as on main a leading keyword is not stripped there; bodies fed to a shell (`bash <<EOF`, `cat <<EOF | sh`) are still checked fully through `extra`.
  const bodyLines = reads ? new Set() : new Set(docs.flatMap((d) => d.text.split(/&&|\|\||;|\||\n/).map((x) => x.trim())));
  for (const s of [cmd, joined].flatMap((t) => t.split(/&&|\|\||;|\||\n/))) {
    const n = normalize(s, !bodyLines.has(s.trim()));
    if (n && !seen.has(n)) { seen.add(n); blind.push(n, ...payload(n).flatMap(segments)); }
  }
  return [...new Set([...qa, ...blind])];
}

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

// Secret patterns for the push gate (pre-bash.mjs) and the git pre-commit hook (git-hook.mjs, SID-147): one list, so the two cannot drift.
export const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Anthropic/OpenAI key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Linear key', /\blin_api_[A-Za-z0-9]{20,}\b/],
];
// Names of the patterns that match a line added in a unified or combined (--cc) diff. `+++` is a file header only between `diff ` and the first `@@`: inside a hunk it is
// an added line starting with `++`, or an octopus merge's three-column prefix. A combined hunk opens with one `@` per parent plus one, and only a line with `+` in every
// column is new in the merge. Any other line came from a parent, so that parent's own commit, or origin, already accounts for it.
const addedLines = (diff) => {
  let inHunk = false, prefix = '+';
  return diff.split('\n').filter((l) => {
    if (l.startsWith('diff ')) { inHunk = false; prefix = '+'; return false; }
    if (l.startsWith('@@')) { inHunk = true; prefix = '+'.repeat(/^@+/.exec(l)[0].length - 1); return false; }
    return l.startsWith(prefix) && (inHunk || !l.startsWith('+++'));
  });
};
const secretNames = (lines) => { const added = lines.join('\n'); return SECRET_PATTERNS.filter(([, re]) => re.test(added)).map(([n]) => n); };
export const secretsInDiff = (diff) => secretNames(addedLines(diff));

// The flags stop repo config hiding added lines: color puts escape codes before the `+`, an external diff or textconv driver can print anything, and -diff, binary, a binary diff driver or a NUL byte print
// `Binary files differ` unless --text. A small core.bigFileThreshold also takes a file for binary: on git 2.47 either --text or the override alone defeats it, so removing just one changes no test. Shared with the pre-commit scan, so the two cannot drift.
const SCAN_GLOBALS = ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.bigFileThreshold=1g'];
const SCAN_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text'];
const SCAN_PATHS = ['--', '.', ':(exclude)*.lock', ':(exclude)*.snap'];
export const scanRead = (root, args, maxBuffer = 256 << 20) => execFileSync('git', [...SCAN_GLOBALS, ...args, ...SCAN_FLAGS, ...SCAN_PATHS], { cwd: root, env: NO_REPLACE_ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer }).toString();

// SID-213: the push gate's scan of base..HEAD. Returns null when clean, else { result, detail, reason }: result 'secret' or 'error' for runs.jsonl, reason for the deny.
// Any failure to read the range is an error, never "no secrets". The net diff sees what the final tree adds; the per-commit log sees what history carries to the remote even when a later commit removes it.
// log only: --full-history because a pathspec otherwise skips a side branch whose merge matches the other parent; --root because log.showroot=false hides a root commit's diff; --cc for what a merge itself adds.
// --cc ignores --text, so a merge prints `Binary files differ` for a file it changes that is -diff, binary or holds a NUL byte. Each such merge is read against every parent instead:
// as in --cc, only a line added against all of them is new in the merge. Only when --cc could not read one, because a diff against a parent can carry that whole parent's history into the buffer.
const addedByMerges = (read, range) => read(['log', '--merges', '--full-history', '--format=%H %P', range]).split('\n').filter(Boolean).flatMap((entry) => {
  const [merge, ...parents] = entry.split(' ');
  const perParent = parents.map((p) => new Set(addedLines(read(['diff', `${p}..${merge}`]))));
  return [...perParent[0]].filter((line) => perParent.every((added) => added.has(line)));
});
export function pushSecretScan(root, base, maxBuffer = 256 << 20) {
  const read = (args) => scanRead(root, args, maxBuffer), range = `${base}..HEAD`;
  let net, history;
  try {
    if (!base) throw new Error('no base commit to scan from');
    net = secretsInDiff(read(['diff', range]));
    const log = read(['log', '-p', '--cc', '--root', '--full-history', '--format=%H', range]);
    history = secretNames([...addedLines(log), ...(/^Binary files /m.test(log) ? addedByMerges(read, range) : [])]);
  } catch (e) {
    const first = (e.stderr?.toString().trim() || e.message).split('\n')[0];
    const split = e.code === 'ENOBUFS' ? ' The range is too large to scan: split the push into smaller pushes, landing each on the base branch before the next, because the scan covers everything since the base branch.' : '';
    return { result: 'error', detail: `secret scan: ${first}`, reason: `harness gate: could not read the diff for the secret scan (failing closed): ${first}${split}` };
  }
  const names = [...new Set([...net, ...history])].join(', ');
  if (net.length) return { result: 'secret', detail: names, reason: `harness gate: committed text looks like a secret (${names}); remove it and rewrite the commit before pushing` };
  if (history.length) return { result: 'secret', detail: names, reason: `harness gate: a commit in the pushed range adds text that looks like a secret (${names}), and it would reach the remote in history even though the final tree no longer has it. It must be removed by rewriting those commits (a human step).` };
  return null;
}
