// Git hooks outside Claude (SID-147). The stubs `npm run hooks -- install` writes into <git common dir>/sflow-hooks/ (core.hooksPath) run
//   node <sflow>/hooks/harness/git-hook.mjs <hook name> [git's hook arguments]
// 1. The repo's own hook of that name runs first: the core.hooksPath saved at install in <git common dir>/sflow-hooks/previous-hooks-path, else <git common dir>/hooks.
//    Not a git config value: an agent may run `git config`, but the guard denies every shell write into .git/sflow-hooks (SID-155). The saved path is checked again at
//    run time and must resolve (symlinks followed) inside the git common dir or the repository's working tree, never to the stubs themselves; otherwise the hook fails closed.
// 2. pre-commit and pre-push then run sflow's checks through the SAME guard and gate code as the Claude hook (pre-bash.mjs, lib.mjs): no second implementation.
// Either failing fails the hook. No environment variable turns any of this off, and any internal error fails closed (exit 1).
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, GATE_RECORD_DIR, gitDir, NO_REPLACE_ENV, scanRead, secretsInDiff, STAGED_DRIVER_FLAGS } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ZERO = /^0+$/;
// Git exports GIT_DIR, GIT_INDEX_FILE and friends to hooks. The guard and the gate find the repo from its root instead, and gate commands such as
// `npm test` must not inherit a hook's GIT_INDEX_FILE or quarantine object dir, so these are dropped for everything sflow runs (not for the chained repo hook).
const SCRUB = /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|EXEC_PATH|REFLOG_ACTION|EDITOR|SEQUENCE_EDITOR)$/;
export const cleanEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SCRUB.test(k)));

const fail = (msg) => { process.stderr.write(`sflow ${process.argv[2] ?? 'git'} hook: ${msg}\n`); process.exit(1); };
const gitOut = (cwd, ...args) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: cleanEnv(NO_REPLACE_ENV), stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\n$/, '');
const tryGit = (cwd, ...args) => { try { return gitOut(cwd, ...args); } catch { return null; } };

export const PREV_FILE = 'previous-hooks-path';
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (p, dir) => { const r = relative(real(dir), real(p)); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)); };
// Why `dir` may not be chained as the previous hooks dir, or null. `common` is the git common dir, `tops` the working trees it may live in.
export function prevProblem(dir, common, tops) {
  if (inside(dir, join(common, 'sflow-hooks'))) return `${dir} is sflow's own stub dir`;
  const roots = [common, ...tops, ...(basename(common) === '.git' ? [dirname(common)] : [])];
  return roots.some((r) => inside(dir, r)) ? null : `${dir} resolves to ${real(dir)}, outside the git dir and the working tree`;
}
// The previous hooks dir: the path saved at install, else <common>/hooks. Throws (the hook fails closed) when the saved path fails prevProblem.
export function previousHooksDir(common, tops) {
  const f = join(common, 'sflow-hooks', PREV_FILE);
  if (!existsSync(f)) return join(common, 'hooks');
  const dir = readFileSync(f, 'utf8').replace(/\n$/, '');
  if (!isAbsolute(dir)) throw new Error(`${f} holds a relative path (${dir}); a human reruns \`npm run hooks -- install\``);
  const why = prevProblem(dir, common, tops);
  if (why) throw new Error(`${f}: ${why}; a human reruns \`npm run hooks -- install\``);
  return dir;
}

// The repo's own hook for `name`, or null. Never one of sflow's own stubs (that would loop).
export function chainedHook(root, name) {
  const common = resolve(root, gitOut(root, 'rev-parse', '--git-common-dir'));
  const dir = previousHooksDir(common, [root]);
  const p = join(dir, name);
  try { accessSync(p, constants.X_OK); } catch { return null; }
  return existsSync(p) && !isDirectory(p) ? p : null;
}
const isDirectory = (p) => { try { return execFileSync('test', ['-d', p], { stdio: 'ignore' }), true; } catch { return false; } };

// One pre-push stdin line -> the git push command a Claude agent would have typed for the same ref update, so pre-bash.mjs judges it.
export function pushCommand(root, remote, [localRef, localSha, remoteRef, remoteSha]) {
  const dst = remoteRef.replace(/^refs\/heads\//, '');
  if (ZERO.test(localSha)) return `git push ${remote} --delete ${dst}`;
  const src = localRef.startsWith('refs/heads/') ? localRef.slice(11) : localSha;
  // Not a fast-forward (or the remote commit is unknown here): it is a force push, whatever flags the human used.
  const ff = ZERO.test(remoteSha) || (tryGit(root, 'cat-file', '-e', `${remoteSha}^{commit}`) !== null && tryGit(root, 'merge-base', '--is-ancestor', remoteSha, localSha) !== null);
  return `git push${ff ? '' : ' --force'} ${remote} ${src}:${dst}`;
}

// Run pre-bash.mjs on `command` as the Claude hook would; returns its deny reason or null.
export function guardVerdict(root, command, script = join(here, 'pre-bash.mjs')) {
  const r = spawnSync(process.execPath, [script], { cwd: root, env: cleanEnv(), input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }), maxBuffer: 256 << 20 });
  if (r.status !== 0 || r.error) return `the guard exited ${r.status ?? r.error?.message} (failing closed)`;
  const out = r.stdout.toString().trim();
  if (!out) return null;
  try { const o = JSON.parse(out).hookSpecificOutput; return o?.permissionDecision === 'deny' ? o.permissionDecisionReason : null; } catch { return `unreadable guard output (failing closed): ${out.slice(0, 200)}`; }
}

function prePush(root, remote, input) {
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/));
  if (!lines.length) return;
  if (lines.some((l) => l.length !== 4)) fail('unexpected pre-push input (failing closed)');
  const head = tryGit(root, 'rev-parse', 'HEAD');
  for (const l of lines) {
    const command = pushCommand(root, remote, l);
    const why = guardVerdict(root, command);
    if (why) fail(`${why}\n  (judged as: ${command})`);
  }
  // The guard gates HEAD. A push of another commit would go out unchecked, so it is refused while a gate is in force.
  const cfg = config(root);
  if (!cfg.present) { console.error(`sflow gate skipped: no .harness.json committed on origin (${cfg.candidates?.map((b) => `origin/${b}`).join(', ') || 'no base branch'})`); return; }
  if (!cfg.gate.length) { console.error(`sflow gate skipped: the gate in ${cfg.source} is empty`); return; }
  const pushed = lines.filter((l) => !ZERO.test(l[1])).map((l) => l[1]);
  if (pushed.some((s) => s !== head)) fail(`the gate checks HEAD (${head?.slice(0, 12)}), and this push sends another commit; check out the branch you push, then push again`);
  if (!pushed.length) return console.error('sflow gate skipped: the push only deletes refs');
  if (!existsSync(join(gitDir(root), GATE_RECORD_DIR, head))) fail(`the gate passed no record for ${head.slice(0, 12)} (failing closed)`);
  console.error(`sflow gate ok ${head.slice(0, 12)}`);
}

function preCommit(root) {
  const why = guardVerdict(root, 'git commit');
  if (why) fail(why);
  // Staged secrets, with the push gate's patterns. GIT_INDEX_FILE is kept here on purpose: `git commit -a` and `git commit <path>` stage into a temporary index.
  let diff = '';
  try { diff = [scanRead(root, ['diff', '--cached']), scanRead(root, ['diff', '--cached'], { flags: STAGED_DRIVER_FLAGS })].join('\n'); } catch (e) { fail(`could not read the staged diff (failing closed): ${e.message}`); }
  const hits = secretsInDiff(diff);
  if (hits.length) fail(`staged text looks like a secret (${hits.join(', ')}); unstage it (git restore --staged <file>) and remove it`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...args] = process.argv.slice(2);
  try {
    if (!name) fail('no hook name (failing closed)');
    const root = gitOut(process.cwd(), 'rev-parse', '--show-toplevel');
    const input = name === 'pre-push' ? readFileSync(0, 'utf8') : '';
    const prev = chainedHook(root, name);
    if (prev) {
      const r = spawnSync(prev, args, { cwd: process.cwd(), input, stdio: ['pipe', 'inherit', 'inherit'] });
      // EPIPE: the hook exited without reading git's stdin, which git itself allows; its exit status still decides.
      if (r.error && !(r.error.code === 'EPIPE' && r.status !== null)) fail(`the repo's own ${name} hook (${prev}) could not run: ${r.error.message}`);
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    if (name === 'pre-push') prePush(root, args[0] ?? 'origin', input);
    else if (name === 'pre-commit') preCommit(root);
  } catch (e) { fail(`internal error (failing closed): ${e.message}`); }
}
