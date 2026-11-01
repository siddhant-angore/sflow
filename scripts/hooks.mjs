#!/usr/bin/env node
// Git hooks outside Claude (SID-147): run the harness guard and gate on every shell commit and push, not only inside Claude Code.
// A HUMAN runs this once per repo, outside Claude: agents are denied `git config core.hooksPath` by the guard, on purpose.
//   install [--repo <dir>]...  write stubs to <git common dir>/sflow-hooks/, save any previous core.hooksPath (absolute) in
//                              <git common dir>/sflow-hooks/previous-hooks-path, and point core.hooksPath at the stubs. Idempotent; existing repo hooks
//                              are kept and still run first. A previous core.hooksPath outside the git dir and the working tree is refused (nothing changes).
//   check   [--repo <dir>]...  exit 1 unless core.hooksPath points at current, executable stubs for this sflow checkout
// <dir> defaults to the current directory. The stubs call <this sflow>/hooks/harness/git-hook.mjs and fail closed if it is gone.
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREV_FILE, prevProblem, previousHooksDir } from '../hooks/harness/git-hook.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DISPATCHER = join(root, 'hooks', 'harness', 'git-hook.mjs');
export const SFLOW_HOOKS = ['pre-commit', 'pre-push'];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().replace(/\n$/, '');
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function stub(name, dispatcher = DISPATCHER) {
  return `#!/bin/sh
# sflow git hook (SID-147), written by \`npm run hooks -- install\`. Do not edit; rerun install instead.
# Runs the repo's own ${name} hook (if any), then the sflow harness checks. It fails closed if sflow is not where install found it.
D=${sq(dispatcher)}
if [ ! -f "$D" ]; then echo "sflow ${name} hook: $D is missing; rerun \\\`npm run hooks -- install\\\` from your sflow checkout" >&2; exit 1; fi
exec node "$D" ${name} "$@"
`;
}

export function paths(repo) {
  const top = git(repo, 'rev-parse', '--show-toplevel');
  const common = resolve(top, git(top, 'rev-parse', '--git-common-dir'));
  return { top, common, dir: join(common, 'sflow-hooks') };
}
const same = (a, b) => { const r = (p) => { try { return realpathSync(p); } catch { return resolve(p); } }; return r(a) === r(b); };
const isExec = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
// core.hooksPath as git reads it: `~/` is the home dir, a relative path is relative to the working tree.
const absHooks = (top, v) => (isAbsolute(v) ? v : /^~\//.test(v) ? join(process.env.HOME ?? '~', v.slice(2)) : resolve(top, v));
// The names to stub: sflow's own, plus every executable hook in the previous hooks dir (so moving core.hooksPath turns none of them off).
const wanted = (prev) => [...new Set([...SFLOW_HOOKS, ...(existsSync(prev) ? readdirSync(prev).filter((f) => !f.endsWith('.sample') && isExec(join(prev, f))) : [])])].sort();

export function install(repo, { log = console.log } = {}) {
  const { top, common, dir } = paths(repo);
  const current = tryGit(top, 'config', '--local', '--get', 'core.hooksPath');
  const moving = current && !same(absHooks(top, current), dir);
  if (moving) { // checked before anything is written, so a refusal changes nothing
    const why = prevProblem(absHooks(top, current), common, [top]);
    if (why) { log(`REFUSED   ${top}: the current core.hooksPath ${current} can't be chained (${why}); move those hooks into the repo or unset core.hooksPath, then rerun`); return false; }
  }
  mkdirSync(dir, { recursive: true });
  if (moving) {
    const f = join(dir, PREV_FILE), text = `${absHooks(top, current)}\n`;
    if (!existsSync(f) || readFileSync(f, 'utf8') !== text) writeFileSync(f, text, { mode: 0o644 });
    log(`saved     previous core.hooksPath ${current} in ${f} (it still runs first)`);
  }
  const prev = previousHooksDir(common, [top]);
  let changed = 0;
  for (const name of wanted(prev)) {
    const p = join(dir, name), text = stub(name);
    if (existsSync(p) && readFileSync(p, 'utf8') === text && isExec(p)) continue;
    writeFileSync(p, text); chmodSync(p, 0o755); changed++;
  }
  if (!current || moving) { git(top, 'config', '--local', 'core.hooksPath', dir); changed++; }
  log(`${changed ? 'installed' : 'current  '} ${top} (core.hooksPath ${dir})`);
  return check(repo, { log: () => {} });
}

export function check(repo, { log = console.log } = {}) {
  let p; try { p = paths(repo); } catch { log(`NOT A REPO ${resolve(repo)}`); return false; }
  const { top, common, dir } = p;
  const current = tryGit(top, 'config', '--get', 'core.hooksPath');
  if (!current || !same(absHooks(top, current), dir)) { log(`NOT INSTALLED ${top} (core.hooksPath is ${current ?? 'unset'}; a human runs: npm run hooks -- install --repo ${top})`); return false; }
  const problems = [];
  if (!existsSync(DISPATCHER)) problems.push(`${DISPATCHER} is missing`);
  let prev; try { prev = previousHooksDir(common, [top]); } catch (e) { problems.push(e.message); prev = join(common, 'hooks'); }
  for (const name of wanted(prev)) {
    const f = join(dir, name);
    if (!existsSync(f)) problems.push(`${name}: stub missing`);
    else if (!isExec(f)) problems.push(`${name}: stub not executable`);
    else if (readFileSync(f, 'utf8') !== stub(name)) problems.push(`${name}: stub is stale or edited`);
  }
  if (problems.length) { log(`STALE     ${top}\n  ${problems.join('\n  ')}\n  a human reruns: npm run hooks -- install --repo ${top}`); return false; }
  log(`ok        ${top} (${wanted(prev).join(', ')}; core.hooksPath ${dir})`);
  return true;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const usage = 'usage: hooks.mjs install|check [--repo <dir>]...';
  const repos = []; let bad = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--repo' && args[i + 1]) repos.push(args[++i]); else bad ??= args[i]; }
  if (bad || !['install', 'check'].includes(cmd)) { console.error(bad ? `unknown argument ${bad}\n${usage}` : usage); process.exit(2); }
  let ok = true;
  for (const r of repos.length ? repos : ['.']) ok = (cmd === 'install' ? install(r) : check(r)) && ok;
  process.exit(ok ? 0 : 1);
}
