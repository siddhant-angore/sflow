#!/usr/bin/env node
// The mutation proof for SID-243 and SID-244. Each row changes one check in a scratch copy of the hooks and runs scripts/test-diff-guard.mjs against it, one at a time; the tree is never touched.
// node scripts/mutate-diff-guard.mjs [name filter]. Exit 1 when a mutant survives, when a row's text no longer matches the source, or when a mutant only crashes on load. A row with a seventh field is argued equivalent: it must survive, and is listed with the argument.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratch } from './scratch.mjs';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const G = 'guard-rules.mjs', L = 'lib.mjs', P = 'pre-bash.mjs';
const KEY = String.raw`const DRIVER_KEY = /^diff\.(?:external|[\s\S]*\.(?:textconv|command))$/i;`;
const PARAM = String.raw`const DRIVER_PARAM = /(?:^|[\s"'=])diff\.(?:external|[^='"]*\.(?:textconv|command))(?=$|[\s"'=])/i;`;
const TEXT = String.raw`["']?diff\.(?:external|[^=\n]*?\.(?:textconv|command))["']?(?=[\s=;&|)"'` + '`' + String.raw`]|$)/i;`;
const SECTION = String.raw`const DRIVER_SECTION = /^diff(?:\.[\s\S]*)?$/i;`;
const CONFIG = ['guard', 'variants'], SCAN = ['scan'], GATE = ['gate'];
const M = [
  // case-insensitive flag, one per regex
  ['drop i: DRIVER_KEY', G, KEY, KEY.replace(/i;$/, ';'), CONFIG],
  ['drop i: DRIVER_SECTION', G, SECTION, SECTION.replace(/i;$/, ';'), CONFIG],
  ['drop i: DRIVER_PARAM', G, PARAM, PARAM.replace(/i;$/, ';'), CONFIG],
  ['drop i: DRIVER_TEXT', G, TEXT, TEXT.replace(/i;$/, ';'), CONFIG],
  // each key family, in each of the three matchers
  ['DRIVER_KEY without external', G, KEY, KEY.replace('external|', 'zz|'), CONFIG],
  ['DRIVER_KEY without textconv', G, KEY, KEY.replace('textconv|', ''), CONFIG],
  ['DRIVER_KEY without command', G, KEY, KEY.replace('|command', ''), CONFIG],
  ['DRIVER_PARAM without external', G, PARAM, PARAM.replace('external|', 'zz|'), CONFIG],
  ['DRIVER_PARAM without textconv', G, PARAM, PARAM.replace('textconv|', ''), CONFIG],
  ['DRIVER_PARAM without command', G, PARAM, PARAM.replace('|command', ''), CONFIG],
  ['DRIVER_TEXT without external', G, TEXT, TEXT.replace('external|', 'zz|'), CONFIG],
  ['DRIVER_TEXT without textconv', G, TEXT, TEXT.replace('textconv|', ''), CONFIG],
  ['DRIVER_TEXT without command', G, TEXT, TEXT.replace('|command', ''), CONFIG],
  ['a driver name must have no dots', G, KEY, KEY.replace(String.raw`[\s\S]*`, String.raw`[^.]*`), CONFIG],
  ['a driver name must not be empty', G, KEY, KEY.replace(String.raw`[\s\S]*`, String.raw`[\s\S]+`), CONFIG],
  // git config parsing
  ['config rule not wired', G, ' ?? driverConfigReason(raw);', ';', CONFIG],
  ['section rule dropped', G, "pos.some((x) => DRIVER_SECTION.test(x))) return NO_DIFF_DRIVER;", "false) return NO_DIFF_DRIVER;", CONFIG],
  ['--rename/--remove-section option not seen', G, "(opts.has('rename-section') || opts.has('remove-section') || [", '([', CONFIG],
  ['section subcommands not seen', G, "|| ['rename-section', 'remove-section'].includes(pos[0])) && pos", ') && pos', CONFIG],
  ['--add/--unset options not writes', G, "[...opts].some((o) => CONFIG_WRITES.has(o)) || ['set', 'unset']", "['set', 'unset']", CONFIG],
  ['set/unset subcommands not writes', G, "|| ['set', 'unset'].includes(pos[0])) return NO_DIFF_DRIVER;", ') return NO_DIFF_DRIVER;', CONFIG],
  ['reads not recognized', G, "const reads = [...opts].some((o) => CONFIG_READS.has(o));", 'const reads = false;', CONFIG],
  ['a bare key counts as a write', G, '!reads && pos.length > k + 1 ?', '!reads ?', CONFIG],
  ['a read flag with a value counts as a write', G, '!reads && pos.length > k + 1 ?', 'pos.length > k + 1 ?', CONFIG],
  ['option values not skipped', G, "if (CONFIG_VALUE_OPTS.includes(opt)) { if (!t.includes('=')) i++; } else if (opt) opts.add(opt);", 'if (opt) opts.add(opt);', CONFIG],
  ['--opt=value counts as taking the next word', G, "if (!t.includes('=')) i++; }", 'i++; }', CONFIG],
  ['no option abbreviations', G, 'prefixed.length === 1 ? prefixed[0] : null;', 'null;', CONFIG],
  ['-- not handled', G, "if (t === '--') { pos.push(...w.slice(i + 1)); break; }", '', CONFIG],
  ['-f value not skipped', G, "if (t[k] === 'f') { if (k + 1 === t.length) i++; break; }", "if (t[k] === 'f') break;", CONFIG],
  ['-f attached value counts as taking the next word', G, "if (k + 1 === t.length) i++; break; }", 'i++; break; }', CONFIG],
  ['closing backtick stays on the key', G, ".map((x) => x.replace(/`$/, ''))", '', CONFIG],
  // per-command overrides
  ['override rule not wired', G, ' ?? driverOverrideReason(cmd) ?? attrMentionReason(cmd);', ' ?? attrMentionReason(cmd);', CONFIG],
  ['override read drops the pieces', G, 'for (const t of new Set([cmd, ...rawSegments(cmd)])) for (const { w } of simpleCommands(canon(t).text)) {\n    for (const x of w) {', 'for (const t of [cmd]) for (const { w } of simpleCommands(canon(t).text)) {\n    for (const x of w) {', CONFIG],
  ['override read leaves pieces quoted', G, 'for (const t of new Set([cmd, ...rawSegments(cmd)])) for (const { w } of simpleCommands(canon(t).text)) {\n    for (const x of w) {', 'for (const t of new Set([cmd, ...rawSegments(cmd)])) for (const { w } of simpleCommands(`"${t}"`)) {\n    for (const x of w) {', CONFIG],
  ['-c not read', G, "x === '-c' || x === '--config-env' ? c[++j] ?? ''", "x === '--config-env' ? c[++j] ?? ''", CONFIG],
  ['--config-env <v> not read', G, "x === '-c' || x === '--config-env' ? c[++j] ?? ''", "x === '-c' ? c[++j] ?? ''", CONFIG],
  ['--config-env=<v> not read', G, "x.startsWith('--config-env=') ? x.slice(13) : null;", 'null;', CONFIG],
  ['GIT_CONFIG_KEY_n not read', G, '(key !== undefined && DRIVER_KEY.test(key)) || ', '', CONFIG],
  ['GIT_CONFIG_PARAMETERS not read', G, "|| (x.startsWith('GIT_CONFIG_PARAMETERS=') && DRIVER_PARAM.test(x))", '', CONFIG],
  ['-c key: first = ignored', G, "(DRIVER_KEY.test(v.slice(0, v.indexOf('='))) || ", '(', CONFIG],
  ['--config-env key: last = ignored', G, " || DRIVER_KEY.test(v.slice(0, v.lastIndexOf('='))))", ')', CONFIG],
  ['wrappers not peeled in the override read', G, "const c = peel(w.slice(w.findIndex((x) => !SKIP_HEAD.has(x))));\n    if (base(c[0] ?? '') !== 'git') continue;", "const c = w.slice(w.findIndex((x) => !SKIP_HEAD.has(x)));\n    if (base(c[0] ?? '') !== 'git') continue;", CONFIG],
  ['keywords not skipped in the override read', G, "const c = peel(w.slice(w.findIndex((x) => !SKIP_HEAD.has(x))));\n    if (base(c[0] ?? '') !== 'git') continue;", "const c = peel(w);\n    if (base(c[0] ?? '') !== 'git') continue;", CONFIG],
  ['git option values not skipped', G, 'if (GIT_GLOBAL_VALUE.test(x)) j++;', '', CONFIG],
  ['whole-line -c/--config-env/KEY read dropped', G, 'if (DRIVER_TEXT.test(cmd) && !quotesAreData(cmd)) return NO_DIFF_DRIVER;', '', CONFIG],
  ['whole-line read ignores data lines', G, 'if (DRIVER_TEXT.test(cmd) && !quotesAreData(cmd))', 'if (DRIVER_TEXT.test(cmd))', CONFIG],
  ['whole-line GIT_CONFIG_PARAMETERS read dropped', G, 'if (params && DRIVER_PARAM.test(params[1]) && !quotesAreData(cmd)) return NO_DIFF_DRIVER;', '', CONFIG],
  ['whole-line GIT_CONFIG_PARAMETERS ignores data lines', G, 'if (params && DRIVER_PARAM.test(params[1]) && !quotesAreData(cmd))', 'if (params && DRIVER_PARAM.test(params[1]))', CONFIG],
  ['a heredoc that expands counts as data', L, "return docs.every((d) => d.quoted) && out", 'return out', CONFIG],
  ['a line that writes a file counts as data', L, 'out.every(nonExec) && !writesFile(joined);', 'out.every(nonExec);', CONFIG],
  // setsid
  ['setsid not a wrapper', L, "nohup: '', setsid: '', time:", "nohup: '', time:", CONFIG],
  // .git/info/attributes
  ['attributes rule not wired', G, ' ?? attrMentionReason(cmd);', ';', CONFIG],
  ['attributes write scan dropped', G, "if (gitWrites(t).some((x) => x.kind === 'attributes')) return NO_INFO_ATTRIBUTES;", '', CONFIG],
  ['attributes write scan only on the whole line', G, "for (const t of new Set([cmd, ...rawSegments(cmd)])) {\n    if (gitWrites", 'for (const t of [cmd]) {\n    if (gitWrites', CONFIG],
  ['attributes mention rule dropped', G, 'if (!ATTR_READERS.has(base(c[0] ?? \'\')) && w.some((x) => ATTR_MENTION.test(posix.normalize(x)))) return NO_INFO_ATTRIBUTES;', '', CONFIG],
  ['mention: no normalize', G, 'ATTR_MENTION.test(posix.normalize(x))', 'ATTR_MENTION.test(x)', CONFIG],
  ['mention: cat is not a reader', G, "const ATTR_READERS = new Set(['cat', ", 'const ATTR_READERS = new Set([', CONFIG],
  ['mention: cp is not a reader', G, "'uniq', 'cp', 'dd',", "'uniq', 'dd',", CONFIG],
  ['mention: awk is a reader', G, "const ATTR_READERS = new Set(['cat', ", "const ATTR_READERS = new Set(['awk', 'cat', ", CONFIG],
  ['mention: python3 is a reader', G, "const ATTR_READERS = new Set(['cat', ", "const ATTR_READERS = new Set(['python3', 'cat', ", CONFIG],
  ['mention: suffix allowed in', G, 'info\\/attributes(?![\\w.-])/i', 'info\\/attributes/i', CONFIG],
  ['isInfoAttributes: case sensitive', L, 'info\\/attributes$/i;', 'info\\/attributes$/;', CONFIG],
  ['isInfoAttributes: no modules or worktrees', L, "const ATTR_FILE = /(?:^|\\/)[^\\/\\s]*\\.git\\/(?:modules\\/.+\\/|worktrees\\/[^\\/]+\\/)?info", "const ATTR_FILE = /(?:^|\\/)[^\\/\\s]*\\.git\\/info", CONFIG],
  ['isInfoAttributes: no normalize', L, 'const n = posix.normalize(String(p));', 'const n = String(p);', CONFIG],
  ['isInfoAttributes: globs not read', L, "if (!/[*?[]/.test(n)) return false;\n  const c = n.split('/').slice(-3);", "return false;\n  const c = n.split('/').slice(-3);", CONFIG],
  ['--git-path info/attributes not rewritten', L, ".replace(/\\$\\(\\s*git\\s+rev-parse\\s+--git-path\\s+info\\/attributes\\s*\\)|`\\s*git\\s+rev-parse\\s+--git-path\\s+info\\/attributes\\s*`/g, '.git/info/attributes')", '', CONFIG],
  ['a copy into .git/info is not a write', L, "if (isInfoAttributes(`${p}/attributes`)) writes.push(", "if (false) writes.push(", CONFIG],
  ['a copy into .git/info ignores a cd', L, "for (const p of cwd && !/^[\\/~$]/.test(dest) ? [dest, `${cwd}/${dest}`] : [dest]) if (isInfoAttributes", 'for (const p of [dest]) if (isInfoAttributes', CONFIG],
  ['rsync not a writer', L, "'install', 'rsync', 'sed'", "'install', 'sed'", CONFIG],
  ['a write through a symlink is not checked', P, "if (why === GIT_FILE_DENY && (hookFileName(tp, at)?.seen ?? []).some((p) => basename(p).toLowerCase() === 'attributes')) {", 'if (false) {', CONFIG],
  ['a write through a symlink checks only the name .git', P, "(hookFileName(tp, at)?.seen ?? []).some((p) => basename(p).toLowerCase() === 'attributes')", "(hookFileName(tp, at)?.seen ?? []).some((p) => p.endsWith('.git/info/attributes'))", CONFIG],
  // SID-244 item 1
  ...['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'].map((v) => [`${v} put back`, L, `'${v}'`, "'GIT_ZZ'", SCAN]),
  // item 2
  ['advice flag dropped', L, ", '-c', 'advice.graftFileDeprecated=false']", ']', SCAN],
  ['fatal line pick dropped', L, 'l.find((x) => /^(?:fatal|error):/.test(x)) ?? ', '', SCAN],
  ['error: line not picked', L, '/^(?:fatal|error):/', '/^fatal:/', SCAN],
  ['fatal: line not picked', L, '/^(?:fatal|error):/', '/^error:/', SCAN],
  ['non-hint fallback dropped', L, " ?? l.find((x) => x.trim() && !/^hint:/.test(x))", '', SCAN],
  ['reason takes the first line again', L, "const first = firstError(e.stderr?.toString().trim() || e.message);", "const first = (e.stderr?.toString().trim() || e.message).split('\\n')[0];", SCAN],
  // item 3
  ['paths not chunked', L, 'if (!cur || size + n > MAX_PATH_BYTES)', 'if (!cur)', SCAN],
  ['per-parent buffer total dropped', L, "if (diff.length > maxBuffer) throw", "if (false) throw", SCAN],
  ['the total is not ENOBUFS', L, "{ code: 'ENOBUFS' });\n    return new Set", "{ code: 'X' });\n    return new Set", SCAN],
  ['E2BIG hint dropped', L, "e.code === 'E2BIG' ?", "false ?", SCAN],
  ['every error gets the E2BIG hint', L, "e.code === 'E2BIG' ?", 'true ?', SCAN],
  ['exec seam ignored', L, 'const read = (args, opts) => exec(root, args, { maxBuffer, ...opts })', 'const read = (args, opts) => scanRead(root, args, { maxBuffer, ...opts })', SCAN],
  ['chunks drop :(literal)', L, "chunked(changed).map((c) => ['--', ...c.map((p) => `:(literal)${p}`), ...SCAN_EXCLUDES])", "chunked(changed).map((c) => ['--', ...c, ...SCAN_EXCLUDES])", SCAN],
  ['chunks drop the excludes', L, "...c.map((p) => `:(literal)${p}`), ...SCAN_EXCLUDES])", "...c.map((p) => `:(literal)${p}`)])", SCAN],
  // item 4
  ['gate env reverted', P, 'env: gateEnv(cfg.root), timeout', 'env: NO_REPLACE_ENV, timeout', GATE],
  ['shallow override always dropped', L, "if (missing(join(common, 'shallow'))) delete env.GIT_SHALLOW_FILE;", 'delete env.GIT_SHALLOW_FILE;', GATE],
  ['shallow override never dropped', L, "if (missing(join(common, 'shallow'))) delete env.GIT_SHALLOW_FILE;", '', GATE],
  ['graft override always dropped', L, "if (missing(join(common, 'info', 'grafts'))) delete env.GIT_GRAFT_FILE;", 'delete env.GIT_GRAFT_FILE;', GATE],
  ['graft override never dropped', L, "if (missing(join(common, 'info', 'grafts'))) delete env.GIT_GRAFT_FILE;", '', GATE],
  ['looks in the per-worktree git dir', L, "git(root, 'rev-parse', '--git-common-dir')), env =", "git(root, 'rev-parse', '--absolute-git-dir')), env =", GATE],
  ['a dangling symlink counts as missing', L, 'try { lstatSync(p); return false; }', 'try { statSync(p); return false; }', GATE],
  ['the scan runs with the gate env', L, "execFileSync('git', [...SCAN_GLOBALS, ...args, ...flags, ...paths], { cwd: root, env: NO_REPLACE_ENV,", "execFileSync('git', [...SCAN_GLOBALS, ...args, ...flags, ...paths], { cwd: root, env: gateEnv(root),", GATE, null, 'with no shallow or grafts file the override changes no walk, and with one gateEnv keeps it, so the scan reads the same history either way; core.commitGraph=false and the advice flag cover the rest. This is the argument that the gate env is safe.'],
  ['the gate env is read once, before the first command', P, 'for (const raw of cfg.gate) {', 'const onceEnv = gateEnv(cfg.root);\n  for (const raw of cfg.gate) {', GATE, ['env: gateEnv(cfg.root), timeout', 'env: onceEnv, timeout']],
];

const filter = process.argv[2], rows = [];
const fresh = (dir) => {
  mkdirSync(join(dir, 'hooks'), { recursive: true }); mkdirSync(join(dir, 'scripts'));
  cpSync(join(root, 'workflows', 'hooks'), join(dir, 'hooks', 'harness'), { recursive: true });
  for (const f of ['test-diff-guard.mjs', 'sid243-cases.mjs', 'scratch.mjs']) cpSync(join(root, 'scripts', f), join(dir, 'scripts', f));
};
let bad = 0, n = 0, equiv = 0;
const list = M.filter(([name]) => !filter || name.includes(filter));
for (const [name, file, from, to, sections, also, equivalent] of list) {
  n++;
  const dir = scratch('sid243-mut-'); fresh(dir);
  const f = join(dir, 'hooks', 'harness', file); let s = readFileSync(f, 'utf8');
  const apply = (a, b) => { if (s.split(a).length !== 2) throw new Error(`mutation "${name}": expected one match of: ${a.slice(0, 90)}`); s = s.replace(a, () => b); };
  apply(from, to); if (also) apply(also[0], also[1]);
  writeFileSync(f, s);
  const r = spawnSync('node', ['scripts/test-diff-guard.mjs', ...sections], { cwd: dir, env: { ...process.env, SID243_FAIL_FAST: '1' }, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300_000 });
  const crash = r.status && !/^FAIL /m.test(r.stdout ?? '') ? (r.stderr ?? '').split('\n').find((l) => /Error/.test(l))?.slice(0, 120) ?? 'no output' : null;
  const killer = /^FAIL (.*)$/m.exec(r.stdout ?? '')?.[1]?.slice(0, 150) ?? null;
  if (crash || (equivalent ? killer : !killer)) bad++;
  if (equivalent && !killer && !crash) equiv++;
  rows.push([name, killer]);
  console.log(`${crash ? 'CRASHED ' : killer ? 'killed  ' : equivalent ? 'equiv   ' : 'SURVIVED'} ${name}${crash ? `  <-  ${crash}` : killer ? `  <-  ${killer}` : equivalent ? `  <-  ${equivalent}` : ''}`);
  execFileSync('rm', ['-rf', dir]);
}
console.log(`\n${n} mutants, ${n - bad - equiv} killed, ${equiv} equivalent, ${bad} survived or crashed`);
if (bad) process.exit(1);
