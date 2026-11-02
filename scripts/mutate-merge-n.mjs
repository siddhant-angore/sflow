#!/usr/bin/env node
// The mutation proof for SID-247. Each row changes one check in a scratch copy of the hooks (or of the test's ALLOWLIST matcher) and runs the SID-247 block of scripts/test-hooks.mjs against it, one at a time; the tree is never touched.
// node scripts/mutate-merge-n.mjs [name filter]. Exit 1 when a mutant survives, when a row's text no longer matches the source, or when a mutant only crashes on load. A row with a fifth field is argued equivalent: it must survive, and is listed with the argument.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { scratch } from './scratch.mjs';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const G = 'hooks/harness/guard-rules.mjs', T = 'scripts/test-hooks.mjs';
const FLAG = '--no-verify';
const TABLE = 'const NO_STAT_OPTIONS = {\n  __proto__: null,';
const SKIP = String.raw`if (w === '-n' || /^-X\S/.test(w)) continue;`;
const STOP = "if (w === '--') { kept.push(...words.slice(i)); break; }";
const MERGE_SHORT = String.raw`/^-[evq]*(?:([mXsF])|[mXsF].+|S.*)?$/`;
const REBASE_SHORT = String.raw`/^-[qvfmi]*(?:([sXC])|[sXC].+|[Sr].*)?$/`;
const RULE = String.raw`[/^git\s+(commit|merge|rebase)\b.*(\s${FLAG}\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)/,`;
const KEEP_FLAG = `s.split(/\\s+/).some((x) => isAbbrev(x, '${FLAG}')) || `;
const MATCH_HIT = String.raw`hits.every((s) => named.test(s) && !/[$` + '`' + String.raw`]/.test(s) && `;
const NAMED = String.raw`named = /^git\s+(merge|rebase)\s/`;
const MATCH_SKIP = String.raw`const isOption = !literal && !value && (w === '-n' || /^-X\S/.test(w));`;
const MATCH_MERGE_VALUED = String.raw`merge: [/^(-[evq]*[mXsF]|--(message|file|`;
const MATCH_MERGE_PLAIN = String.raw`/^(-[evq]*([mXsF]\S+|S\S*)?|`;
const MATCH_TABLE = 'const SID247_OPTION_WORDS = {';
const VALUE_NEXT = "if (next && head === w && i + 1 < words.length) kept.push(words[++i]);";
const QUOTED_DENY = 'const quoted = quotedGitOption(cmd, segs);\n  if (quoted) return { why: NO_QUOTED_GLOBAL(quoted), seg: cmd };\n';
const KEEP_QUOTED = 'quotedGitOption(cmd, segs) !== null || ';
const NOT_LITERAL = String.raw`NOT_LITERAL = /["'\\$` + '`' + ']/';
const M = [
  // which commands
  ['the allow widened to commit', G, TABLE, `${TABLE}\n  commit: { short: /^-/, flags: new Set(), values: new Set() },`],
  ['the allow widened to am', G, TABLE, `${TABLE}\n  am: { short: /^-/, flags: new Set(), values: new Set() },`, 'the rule that reads this text has no `am` in its head, and no other rule in the table reads git am, so the text it sees changes no verdict. git am -n and its long form stay allowed as pinned for SID-238; the row below proves the pin bites.'],
  ['the rule also covers am (pin bites)', G, RULE, RULE.replace('(commit|merge|rebase)', '(am|commit|merge|rebase)')],
  ['rebase dropped from the allow', G, '  rebase: {\n', '  rebasex: {\n'],
  ['merge dropped from the allow', G, '  merge: {\n', '  mergex: {\n'],
  ['merge-file and merge-base count as merge', G, String.raw`/^git\s+(\S+)\s+(.*)$/s.exec(seg)`, String.raw`/^git\s+([a-z]+)\S*\s+(.*)$/s.exec(seg)`],
  ['the table has a prototype', G, '  __proto__: null,\n', '', { throws: "reading 'exec'" }],
  // what the rule skips
  ['clusters allowed', G, SKIP, String.raw`if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) || /^-X\S/.test(w)) continue;`],
  ['the whole flag dropped from the rule', G, RULE, RULE.replace(String.raw`\s${FLAG}\b|`, '')],
  ['a --no-verify prefix no longer keeps the rule', G, KEEP_FLAG, ''],
  ['only the whole flag keeps the rule', G, 'name.length >= 3 && flag.startsWith(name)', 'name === flag'],
  ['a prefix needs no minimum length', G, 'name.length >= 3 && ', ''],
  ['a separate -X value treated as glued', G, SKIP, String.raw`if (w === '-n' || /^-X\S/.test(w)) continue; if (w === '-X') { i++; continue; }`],
  ['the -X skip swallows the next word', G, SKIP, String.raw`if (w === '-n') continue; if (/^-X\S/.test(w)) { i++; continue; }`],
  ['a bare -X is skipped too', G, SKIP, String.raw`if (w === '-n' || /^-X\S*/.test(w)) continue;`],
  ['glued -X not skipped', G, SKIP, "if (w === '-n') continue;"],
  ['bare -n not skipped', G, SKIP, String.raw`if (/^-X\S/.test(w)) continue;`],
  ['the skip reads before quotes are removed', G, '(noStat && noStatText(plain)) || plain', '(noStat && unquoted(noStatText(raw) ?? raw)) || plain'],
  // run 4: shape 1, a word after --
  ['-- does not stop the walk', G, STOP, "if (w === '--') { kept.push(w); continue; }"],
  ['-- drops what follows', G, STOP, "if (w === '--') break;"],
  // run 4: shapes 2 and 3, an option's separate value
  ['no option takes the next word', G, VALUE_NEXT, ''],
  ['-m is a flag to merge', G, MERGE_SHORT, String.raw`/^-[evqm]*(?:([XsF])|[XsF].+|S.*)?$/`],
  ['-X is a flag to merge', G, MERGE_SHORT, String.raw`/^-[evqX]*(?:([msF])|[msF].+|S.*)?$/`],
  ['-s is a flag to merge', G, MERGE_SHORT, String.raw`/^-[evqs]*(?:([mXF])|[mXF].+|S.*)?$/`],
  ['-F is a flag to merge', G, MERGE_SHORT, String.raw`/^-[evqF]*(?:([mXs])|[mXs].+|S.*)?$/`],
  ['-X is a flag to rebase', G, REBASE_SHORT, String.raw`/^-[qvfmiX]*(?:([sC])|[sC].+|[Sr].*)?$/`],
  ['-s is a flag to rebase', G, REBASE_SHORT, String.raw`/^-[qvfmis]*(?:([XC])|[XC].+|[Sr].*)?$/`],
  ['-C is a flag to rebase', G, REBASE_SHORT, String.raw`/^-[qvfmiC]*(?:([sX])|[sX].+|[Sr].*)?$/`],
  ['--onto is a flag to rebase', G, ["'--keep-base --no-keep-base ", "new Set('--onto --whitespace"], ["'--onto --keep-base --no-keep-base ", "new Set('--whitespace"]],
  ['a glued value to merge is read as letters', G, MERGE_SHORT, String.raw`/^-[evq]*(?:([mXsF])|S.*)?$/`],
  ['a glued value to rebase is read as letters', G, REBASE_SHORT, String.raw`/^-[qvfmi]*(?:([sXC])|[Sr].*)?$/`],
  ['long options never take the next word', G, 'return word === name && values.has(name);', 'return false;'],
  ['a value glued by a quote takes the next word', G, 'next && head === w && i + 1', 'next && i + 1'],
  // run 4: shape 4 and the rebase forms, a word git does not list
  ['-x is a flag to merge', G, MERGE_SHORT, String.raw`/^-[evqx]*(?:([mXsF])|[mXsF].+|S.*)?$/`],
  ['-x is a flag to rebase', G, REBASE_SHORT, String.raw`/^-[qvfmix]*(?:([sXC])|[sXC].+|[Sr].*)?$/`],
  ['an unknown short option reads as a flag', G, 'return m ? Boolean(m[1]) : null;', 'return m ? Boolean(m[1]) : false;'],
  ['an unknown long option reads as a flag', G, 'if (!flags.has(name) && !values.has(name)) return null;', ''],
  ['--exec is a known flag to rebase', G, "'--keep-base --no-keep-base ", "'--exec --keep-base --no-keep-base "],
  ['a value after the first quote is not read', G, String.raw`const head = w.split(/["'\\]/)[0], next`, 'const head = /["\'\\\\]/.test(w) ? \'-\' : w, next'],
  ['a word git cannot classify drops only that word', G, 'if (next === null) return null;', 'if (next === null) continue;'],
  ['an unknown word only keeps its own segment', G, "const noStat = !keepsHookRule(segs, cmd);\n  for (const seg of segs) {\n    const why = reason(seg, cfg, branch, noStat)", 'for (const seg of segs) {\n    const why = reason(seg, cfg, branch, !keepsHookRule([seg], cmd))'],
  ['the loosening is never on', G, 'const noStat = !keepsHookRule(segs, cmd);', 'const noStat = false;'],
  // expansions keep the old rule
  ['the default is loose', G, 'branch, noStat = false)', 'branch, noStat = true)'],
  ['a substituted variable reads loose', G, 'const why = reason(c, cfg, branch) ?? reason(s, cfg, branch); if (why) return `${why} (after substituting', 'const why = reason(c, cfg, branch, true) ?? reason(s, cfg, branch, true); if (why) return `${why} (after substituting', 'a line this read could decide has an expansion in a merge or rebase segment. An expanding argument is still probed with -n under the strict rule, an expanding subcommand has its own deny, and an expanding command word is denied by literalReason; a -m value too, since merge and rebase are not value-option commands. Measured on this mutant: every expansion must-deny stays denied (X=-n; git merge -m $X main, C="git merge -n main"; $C, A="merge -n"; git $A main).'],
  ['a command word expansion reads loose', G, "const c = normalize(canon(words.join(' ')).text); if (reason(c, cfg, branch)) return say(w[0]);", "const c = normalize(canon(words.join(' ')).text); if (reason(c, cfg, branch, true)) return say(w[0]);", 'this read matters only when a literal merge or rebase follows an expanding command word, and literalReason ("the command word $G is an expansion") denies that line on its own: measured on this mutant for $G -C . merge -n main, which stays denied with that reason.'],
  ['an expanding argument reads loose', G, 'if (reason(c, cfg, branch)) return say(t);', 'if (reason(c, cfg, branch, true)) return say(t);'],
  // the ALLOWLIST matcher
  ['matcher accepts commit', T, [NAMED, MATCH_TABLE], [NAMED.replace('(merge|', '(commit|merge|'), `${MATCH_TABLE}\n  commit: [/^$/, /^-/],`]],
  ['matcher accepts clusters', T, MATCH_SKIP, String.raw`const isOption = !literal && !value && (/^-[a-zA-Z]*n/.test(w) || /^-X\S/.test(w));`],
  ['matcher accepts lines the old rule never hit (git am)', T, 'return hits.length > 0 && hits.every', 'return hits.every'],
  ['matcher accepts merge-file and merge-base', T, [NAMED, MATCH_TABLE], [String.raw`named = /^git\s+(merge|rebase)\b/`, `${MATCH_TABLE}\n  'merge-file': [/^$/, /^-/], 'merge-base': [/^$/, /^-/],`]],
  ['matcher accepts expansions', T, MATCH_HIT, MATCH_HIT.replace(' && !/[$`]/.test(s)', '')],
  ['matcher ignores a --no-verify prefix', T, `if (segs.some((s) => s.split(/\\s+/).some((w) => prefixOf(w, '${FLAG}')))) return false;`, ''],
  ['matcher: -- does not stop the walk', T, "if (w === '--') literal = true;\n    else if", 'if (w === \'--\') continue;\n    else if'],
  ['matcher: -m value reads as an option', T, [MATCH_MERGE_VALUED, MATCH_MERGE_PLAIN], [String.raw`merge: [/^(-[evq]*[XsF]|--(message|file|`, MATCH_MERGE_PLAIN.replace('[evq]', '[evqm]')]],
  ['matcher: -X value reads as an option', T, [MATCH_MERGE_VALUED, MATCH_MERGE_PLAIN], [String.raw`merge: [/^(-[evq]*[msF]|--(message|file|`, MATCH_MERGE_PLAIN.replace('[evq]', '[evqX]')]],
  ['matcher refuses -m with a value', T, MATCH_MERGE_VALUED, String.raw`merge: [/^(-[evq]*[XsF]|--(message|file|`],
  ['matcher refuses --onto with a value', T, 'rebase: [/^(-[qvfmi]*[sXC]|--(onto|', 'rebase: [/^(-[qvfmi]*[sXC]|--(ontox|'],
  ['matcher: a value never reads as a value', T, 'else if (valued.test(w)) value = true;', 'else if (valued.test(w)) value = false;'],
  ['matcher accepts an unknown option', T, `!plain.test(w.split(/["'\\\\]/)[0])) return null;`, `!plain.test(w.split(/["'\\\\]/)[0])) continue;`],
  ['matcher reads an unknown word in its own segment only', T, 'if (segs.some((s) => named.test(s) && sid247OptionsOut(text(s)) === null)) return false;', ''],
  // CTO review 5730668319: quoted, escaped or expanding global options. Each layer has a test of its own.
  ['the quoted-option deny is dropped', G, QUOTED_DENY, ''],
  ['the SID-247 path ignores a quoted option', G, KEEP_QUOTED, ''],
  ['matcher: no raw check', T, 'if (!sid247PlainGlobals(c)) return false;', ''],
  ['a double quote only counts as not literal', G, NOT_LITERAL, String.raw`NOT_LITERAL = /"/`],
  ['a backslash is literal', G, NOT_LITERAL, String.raw`NOT_LITERAL = /["'$` + '`' + String.raw`]/`],
  ['a single quote is literal', G, NOT_LITERAL, String.raw`NOT_LITERAL = /["\\$` + '`' + String.raw`]/`],
  ['a dollar is literal', G, NOT_LITERAL, String.raw`NOT_LITERAL = /["'\\` + '`' + String.raw`]/`],
  ['a backtick is literal', G, NOT_LITERAL, String.raw`NOT_LITERAL = /["'\\$]/`],
  ['the reader stops only at the end of the words', G, "if (!w[j].startsWith('-')) break;\n        if (GIT_ARG", 'if (GIT_ARG'],
  ['a plain option\'s value reads as an option', G, 'if (GIT_ARG.has(w[j])) j++;\n      }\n    }\n  }\n  return null;', '}\n    }\n  }\n  return null;'],
  ['the reader keeps redirections', G, 'toks(stripRedirs(piece))', 'toks(piece)'],
  ['the reader skips shell payloads', G, 'for (const t of [cmd, ...(segs.payloads ?? [])]) for (const piece of rawSegments(t)) {\n    const w = toks', 'for (const t of [cmd]) for (const piece of rawSegments(t)) {\n    const w = toks'],
  ['the reader names git by its raw word', G, String.raw`if (base(canon(w[i]).text.replace(/^'|'$/g, '')) !== 'git') continue;`, "if (base(w[i]) !== 'git') continue;"],
  ['the reader needs a bare git, no path', G, String.raw`if (base(canon(w[i]).text.replace(/^'|'$/g, '')) !== 'git') continue;`, String.raw`if (canon(w[i]).text.replace(/^'|'$/g, '') !== 'git') continue;`],
  ['the dash is only read off quote marks', G, " || canon(w).text.replace(/^'/, '').startsWith('-')", ''],
  ['the dash is only read through canon', G, "DASH_WORD.test(w) || canon(w)", 'canon(w)'],
  ['the deny does not say how to rewrite', G, 'write git\'s global options plainly, unquoted and unescaped (e.g. git -C dir status), or drop them', 'it is refused'],
  ['--shallow-file is allowed', G, "w[j] === '--shallow-file' || ", ''],
  ['matcher: --shallow-file is accepted', T, "b === '--shallow-file' || ", ''],
  ['matcher: a double quote only counts', T, 'w !== b || /[$`]/.test(w)', 'w.includes(\'"\')'],
  ['matcher: an expansion counts as plain', T, 'w !== b || /[$`]/.test(w)', 'w !== b'],
  ['matcher: a quoted script is not read again', T, 'if (bare !== words[i] && /\\s/.test(bare) && !sid247PlainGlobals(bare)) return false;', ''],
  ['matcher: $\'..\' is read as plain text', T, `w.startsWith("$'") || `, ''],
  ['matcher: a plain option\'s value reads as an option', T, 'if (SID247_GIT_VALUED.has(w)) j++;', ''],
  ['matcher: redirections stay words', T, ".filter((w) => !/^\\d*[<>]/.test(w))", ''],
];

const filter = process.argv[2];
let bad = 0, n = 0, equiv = 0;
for (const [name, file, from, to, equivalent] of M.filter(([x]) => !filter || x.includes(filter))) {
  n++;
  const dir = scratch('sid247-mut-');
  mkdirSync(join(dir, 'hooks'), { recursive: true }); mkdirSync(join(dir, 'scripts'));
  cpSync(join(root, 'workflows', 'hooks'), join(dir, 'hooks', 'harness'), { recursive: true });
  for (const f of ['test-hooks.mjs', 'hook-batch.mjs', 'sid243-cases.mjs', 'sid247-cases.mjs', 'scratch.mjs']) cpSync(join(root, 'scripts', f), join(dir, 'scripts', f));
  const f = join(dir, file);
  let s = readFileSync(f, 'utf8');
  [from].flat().forEach((text, k) => {
    if (s.split(text).length !== 2) throw new Error(`mutation "${name}": expected one match of: ${text.slice(0, 90)}`);
    s = s.replace(text, () => [to].flat()[k]);
  });
  writeFileSync(f, s);
  const r = spawnSync('node', ['scripts/test-hooks.mjs'], { cwd: dir, env: { ...process.env, SFLOW_SID247_ONLY: '1', SID247_SHOW: '1' }, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300_000 });
  const ran = /^SID-247: /m.test(r.stdout ?? '');
  // A row with { throws } makes the rule throw that error on a near miss (git constructor -x): the throw is the kill. Any other crash is a broken row.
  const threw = r.status && !ran && equivalent?.throws && (r.stderr ?? '').includes(equivalent.throws);
  if (threw) { console.log(`killed   ${name}  <-  the rule throws: ${equivalent.throws}`); rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.origin.git`, { recursive: true, force: true }); continue; }
  const argued = typeof equivalent === 'string' ? equivalent : null;
  const killer = r.status && ran ? /^ {2}(.*)$/m.exec(r.stdout)?.[1]?.slice(0, 120) ?? 'assertion' : null;
  const crash = r.status && !ran ? (r.stderr ?? '').split('\n').find((l) => /Error/.test(l))?.slice(0, 120) ?? 'no output' : null;
  if (crash || (argued ? killer : !killer)) bad++;
  if (argued && !killer && !crash) equiv++;
  console.log(`${crash ? 'CRASHED ' : killer ? (argued ? 'NOT-EQUIV' : 'killed  ') : argued ? 'equiv   ' : 'SURVIVED'} ${name}${crash ? `  <-  ${crash}` : killer ? `  <-  ${killer}` : argued ? `  <-  ${argued}` : ''}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.origin.git`, { recursive: true, force: true });
}
console.log(`\n${n} mutants, ${n - bad - equiv} killed, ${equiv} equivalent, ${bad} survived or crashed`);
if (bad) process.exit(1);
