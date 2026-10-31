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

export function normalize(seg) {
  let s = stripRedirs(seg.trim());
  for (let prev = null; prev !== s;) {
    prev = s;
    const [t, rest] = take(s);
    if (t === null) break;
    const b = /^\\?(?:[^\s"'=\\]*\/)?([\w.+-]+)$/.exec(t)?.[1] ?? t;
    if (KEYWORDS.has(t) || /^[A-Za-z_]\w*\+?=/.test(t)) s = rest;
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

// Quoted text is only data when nothing in the command can execute it. `echo 'x; git push -f origin main' | sh` and `... > f.sh && bash f.sh` run it, and `git -c core.pager='...' log` or `GIT_PAGER='...' git log` execute it,
// so quotes are honoured only when every segment (judged raw, after redirections) starts with a command that never runs its arguments; anything else also gets the quote-blind scan.
const NON_EXEC = /^(?:(?:echo|printf|grep|cat|rg|cd|pwd|ls|true|false|:|test|\[|head|tail|wc|sort|uniq|cut|tr|mkdir|touch|tee|sleep)|git\s+(?:add|commit|status|log|diff|show|push|fetch|switch|checkout|restore|branch|rm|mv|tag|stash|reset|clean|rev-parse)|gh\s+(?:pr\s+(?:create|edit|comment|view)|issue\s+(?:create|comment|view)))(?:\s|$)/;
const RUNS_ARG = /(?:^|\s)--(?:upload-pack|receive-pack|exec|compress-program)(?![\w-])/; // options whose value is executed (git runs it through a shell for local and ssh remotes; sort runs a program)
const nonExec = (raw) => { const s = stripRedirs(raw.trim()); return !s || (NON_EXEC.test(s) && !(/^rg\s/.test(s) && /\s--pre/.test(s)) && !RUNS_ARG.test(s)); };

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
  const run = (s) => { const n = normalize(s); return n ? [n, ...payload(n).flatMap(segments)] : []; };
  const qa = [...raw.flatMap(run), ...extra];
  if (!unsure && raw.every(nonExec)) return qa;
  const seen = new Set(qa), blind = [];
  for (const s of [cmd, joined].flatMap((t) => t.split(/&&|\|\||;|\||\n/))) {
    const n = normalize(s);
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

