import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = { protectedBranches: ['main', 'master'], gate: [], allowMerge: false, dod: [] };
export const PLACEHOLDER = 'replace with the project checks';

export function readEvent() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; }
}

// Replace refs (refs/replace/) can swap any object git reads, including the commit and file the policy comes from, so they are off for every call.
// core.fsmonitor=false: a configured fsmonitor hook script would otherwise run inside the hook on `git status`/`diff`.
export const NO_REPLACE_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
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


// SID-191: the command with each word's shell quoting resolved, the way the shell joins it: `g""h` -> gh, `"--for"ce` -> --force, `ma\in` -> main,
// `$'\x67it'` -> git. A word that still holds a special character after unquoting is re-quoted in single quotes (so `-m "a b"` stays one word, and
// quoted text stays data). A word with an expansion the shell would perform ($, a backtick, outside single quotes) is left exactly as written, so
// the literal-argument rules still see it. Operators, comments and heredoc bodies are copied as they are. open: a quote is never closed.
const SAFE_WORD = /^[\w@%+=:,./~^-]+$/;
const ansi = (s) => s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|[\s\S])/g, (_, e) => {
  if (/^x/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
  if (/^u/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
  if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255);
  return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }[e] ?? e;
});
// End of the heredoc delimiter word that starts at j.
const hereEnd = (s, j) => { let k = j; for (; k < s.length && !/[\s;&|()<>]/.test(s[k]); k++) { if (s[k] === '\\') k++; else if (s[k] === "'" || s[k] === '"') k = quoteEnd(s, k) - 1; } return k; };
// Skip the heredoc bodies pending after the newline at i (index of the newline); returns the index after the last body line.
const skipBodies = (s, i, pending) => {
  let pos = i + 1;
  for (const p of pending.splice(0)) for (;;) {
    if (pos >= s.length) return s.length + 1; // never closed
    const e = s.indexOf('\n', pos), end = e < 0 ? s.length : e, line = s.slice(pos, end);
    pos = e < 0 ? s.length : e + 1;
    if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break;
  }
  return pos;
};
// Index after the `)` that closes the $( opening at s[i] (quotes, nested $( ), backticks and heredocs inside are skipped); s.length + 1 if it never closes.
function substEnd(s, i) {
  let d = 1; const pending = [];
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === "'") { j = quoteEnd(s, j) - 1; }
    else if (c === '"') { j = dqEnd(s, j) - 1; }
    else if (c === '`') { let k = j + 1; for (; k < s.length && s[k] !== '`'; k++) if (s[k] === '\\') k++; j = k; }
    else if (c === '$' && s[j + 1] === '(') { j = substEnd(s, j + 1) - 1; }
    else if (c === '<' && s[j + 1] === '<' && s[j + 2] !== '<') { const strip = s[j + 2] === '-'; let k = j + 2 + strip; while (/[ \t]/.test(s[k] ?? '')) k++; const w = hereWord(s, k); if (w) pending.push({ delim: w[0], strip }); j = Math.max(k, hereEnd(s, k)) - 1; }
    else if (c === '\n' && pending.length) { j = skipBodies(s, j, pending) - 1; }
    else if (c === '(') d++;
    else if (c === ')' && --d === 0) return j + 1;
    if (j >= s.length) break;
  }
  return s.length + 1;
}
// Index after the `"` closing the double-quoted string opening at s[i] ($( ) and backticks inside are skipped whole); s.length + 1 if it never closes.
function dqEnd(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
    else if (s[j] === '$' && s[j + 1] === '(') j = substEnd(s, j + 1) - 1;
    else if (s[j] === '`') { let k = j + 1; for (; k < s.length && s[k] !== '`'; k++) if (s[k] === '\\') k++; j = k; }
  }
  return s.length + 1;
}
export function canon(cmd) {
  let out = '', open = false, i = 0;
  const n = cmd.length, pending = [];
  const isOp = (c) => /[\s;&|()<>]/.test(c);
  while (i < n) {
    const c = cmd[i];
    if (c === '\\' && cmd[i + 1] === '\n') { i += 2; continue; } // line continuation
    if (c === '\n' && pending.length) { const e = skipBodies(cmd, i, pending); out += cmd.slice(i, Math.min(e, n)); i = Math.min(e, n); continue; } // heredoc bodies, raw
    if (c === '#' && (out === '' || /[\s;&|()]$/.test(out))) { const e = cmd.indexOf('\n', i), end = e < 0 ? n : e; out += cmd.slice(i, end); i = end; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const strip = cmd[i + 2] === '-'; let j = i + 2 + strip;
      while (/[ \t]/.test(cmd[j] ?? '')) j++;
      const w = hereWord(cmd, j), e = hereEnd(cmd, j);
      if (w) pending.push({ delim: w[0], strip });
      out += cmd.slice(i, e); i = Math.max(e, i + 2); continue;
    }
    if (isOp(c)) { out += c; i++; continue; }
    const start = i; let val = '', quoted = false, expands = false, joined = false; // one word
    while (i < n && !isOp(cmd[i])) {
      const ch = cmd[i];
      if (ch === '\\') { if (cmd[i + 1] === '\n') { joined = true; i += 2; continue; } quoted = true; val += cmd[i + 1] ?? ''; i += 2; }
      else if (ch === "'") { const e = cmd.indexOf("'", i + 1); quoted = true; if (e < 0) { open = true; i = n; } else { val += cmd.slice(i + 1, e); i = e + 1; } }
      else if (ch === '$' && cmd[i + 1] === "'") { const e = quoteEnd(cmd, i); quoted = true; if (e > n) { open = true; i = n; } else { val += ansi(cmd.slice(i + 2, e - 1)); i = e; } }
      else if (ch === '"' || (ch === '$' && cmd[i + 1] === '"')) {
        if (ch === '$') i++;
        const e = dqEnd(cmd, i); quoted = true;
        if (e > n) { open = true; i = n; break; }
        const body = cmd.slice(i + 1, e - 1);
        if (/[$`]/.test(body.replace(/\\[\s\S]/g, ''))) expands = true;
        val += body.replace(/\\([$`"\\\n])/g, (_, x) => (x === '\n' ? '' : x)); i = e;
      }
      else if (ch === '$' && cmd[i + 1] === '(') { expands = true; const e = substEnd(cmd, i + 1); if (e > n) { open = true; i = n; break; } val += cmd.slice(i, e); i = e; }
      else if (ch === '`') { expands = true; let k = i + 1; for (; k < n && cmd[k] !== '`'; k++) if (cmd[k] === '\\') k++; if (k >= n) { open = true; i = n; break; } val += cmd.slice(i, k + 1); i = k + 1; }
      else { if (ch === '$') expands = true; val += ch; i++; }
    }
    // SID-191 review B2: a line continuation inside a word joins it (`c\<newline>ore.hooksPath` is core.hooksPath), so the word is rewritten too.
    const raw = joined ? cmd.slice(start, i).replace(/\\\n/g, '') : cmd.slice(start, i);
    out += !quoted || expands ? raw : val !== '' && SAFE_WORD.test(val) ? val : `'${val.replace(/'/g, `'\\''`)}'`;
  }
  if (pending.length) open = open; // an unterminated heredoc still runs (bash warns), so it does not count as open
  return { text: out, open };
}

// SID-191: the simple commands of a line with their command substitutions left whole (segments() cuts `git checkout "$(x)"` down to
// `git checkout "$`), so expansionReason can see that an argument is an expansion. Commands inside $( ), backticks and sh -c payloads
// are added as their own entries. Normalized like segments().
export function outerCommands(cmd, depth = 0) {
  const out = [], n = cmd.length, pending = [];
  let cur = '', i = 0;
  const flush = () => { const s = normalize(cur); if (s) { out.push(s); if (depth < 8) for (const p of payload(s)) out.push(...outerCommands(p, depth + 1)); } cur = ''; };
  while (i < n) {
    const c = cmd[i];
    if (c === '\\') { cur += cmd.slice(i, i + 2); i += 2; continue; }
    if (c === "'") { const e = cmd.indexOf("'", i + 1), end = e < 0 ? n : e + 1; cur += cmd.slice(i, end); i = end; continue; }
    if (c === '$' && cmd[i + 1] === "'") { const e = Math.min(quoteEnd(cmd, i), n); cur += cmd.slice(i, e); i = e; continue; }
    if (c === '"') { const e = Math.min(dqEnd(cmd, i), n); const body = cmd.slice(i, e); cur += body; i = e; if (depth < 8) for (const m of innerSubs(body)) out.push(...outerCommands(m, depth + 1)); continue; }
    if (c === '$' && cmd[i + 1] === '(') { const e = Math.min(substEnd(cmd, i + 1), n); const body = cmd.slice(i, e); cur += body; i = e; if (depth < 8) out.push(...outerCommands(body.slice(2, -1), depth + 1)); continue; }
    if (c === '`') { let k = i + 1; for (; k < n && cmd[k] !== '`'; k++) if (cmd[k] === '\\') k++; const body = cmd.slice(i, k + 1); cur += body; i = k + 1; if (depth < 8) out.push(...outerCommands(body.slice(1, -1), depth + 1)); continue; }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) { const e = cmd.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') { const strip = cmd[i + 2] === '-'; let k = i + 2 + strip; while (/[ \t]/.test(cmd[k] ?? '')) k++; const w = hereWord(cmd, k); if (w) pending.push({ delim: w[0], strip }); const e = hereEnd(cmd, k); cur += cmd.slice(i, e); i = Math.max(e, i + 2); continue; }
    if (c === '\n' && pending.length) { flush(); i = Math.min(skipBodies(cmd, i, pending), n); continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')' || c === '{' && /(^|\s)$/.test(cur) || (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>')) { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return out;
}
// The $( ) and backtick bodies inside a double-quoted string.
function innerSubs(dq) {
  const out = [];
  for (let j = 1; j < dq.length - 1; j++) {
    if (dq[j] === '\\') j++;
    else if (dq[j] === '$' && dq[j + 1] === '(') { const e = substEnd(dq, j + 1); out.push(dq.slice(j + 2, e - 1)); j = e - 1; }
    else if (dq[j] === '`') { let k = j + 1; for (; k < dq.length && dq[k] !== '`'; k++) if (dq[k] === '\\') k++; out.push(dq.slice(j + 1, k)); j = k; }
  }
  return out;
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
// Names of the patterns that match a line added in a unified diff.
export function secretsInDiff(diff) {
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  return SECRET_PATTERNS.filter(([, re]) => re.test(added)).map(([n]) => n);
}
