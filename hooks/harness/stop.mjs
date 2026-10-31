// Stop: when this branch carries commits, list the mechanical definition-of-done items not met, once per repo state.
// Loop brake: the same unmet items across three different repo states means attempts are not converging. On the third,
// the hook demands an auditable-failure report instead of another attempt, then lets the turn end. Stopping again on an
// unchanged state is silent: the agent was told once and chose to stop, which is its call to explain.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, git, gitDir, readEvent, record } from './lib.mjs';

const MAX_ROUNDS = 3;
const ev = readEvent();
if (ev.stop_hook_active) process.exit(0);
let cfg;
try { cfg = config(ev.cwd); } catch { process.exit(0); }
if (!cfg.root || !cfg.present) process.exit(0); // no repo to inspect (the pre-bash guard fails closed there); Stop only lists done-items, so it must not trap non-repo sessions
try {
  const head = git(cfg.root, 'rev-parse', 'HEAD');
  const dirty = git(cfg.root, 'status', '--porcelain', '--untracked-files=no');
  let ahead = 0;
  if (cfg.baseSha) { try { ahead = Number(git(cfg.root, 'rev-list', '--count', `${cfg.baseSha}..HEAD`)); } catch {} }
  if (ahead === 0) process.exit(0);
  const unmet = [];
  if (dirty) unmet.push('tracked changes are uncommitted; commit them in small, ordered units or say why they stay uncommitted');
  if (cfg.gate.length && !existsSync(join(gitDir(cfg.root), 'harness-gate', head))) unmet.push('the gate in .harness.json has not passed for HEAD; push to run it');
  unmet.push(...cfg.dod);
  if (!unmet.length) process.exit(0);

  // key = what is unmet; state = the repo as it stands. A new state with the same key is an attempt that did not converge.
  const stampPath = join(gitDir(cfg.root), 'harness-stop');
  const key = createHash('sha1').update(unmet.join('|')).digest('hex');
  const state = createHash('sha1').update(head + git(cfg.root, 'diff', 'HEAD')).digest('hex');
  let stamp = { key: null, state: null, rounds: 0, reported: false };
  try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')); } catch {}
  const sameKey = stamp.key === key;
  if (sameKey && (stamp.state === state || stamp.reported)) process.exit(0);
  const rounds = sameKey ? stamp.rounds + 1 : 1;
  const brake = rounds >= MAX_ROUNDS;
  writeFileSync(stampPath, JSON.stringify({ key, state, rounds, reported: brake }) + '\n');
  record(cfg.root, { kind: 'stop', head: head.slice(0, 12), unmet, rounds, decision: brake ? 'brake' : 'block' });
  const reason = brake
    ? `harness brake: the same definition-of-done items have been unmet ${rounds} times on this repo state. Do not retry. Reply with an auditable failure report, then stop: (1) each unmet item and the error it produced; (2) what each attempt changed; (3) \`git diff --stat\` of the working tree; (4) the exact command to resume. Unmet:\n- ${unmet.join('\n- ')}`
    : `harness definition of done, unmet or unconfirmed (round ${rounds} of ${MAX_ROUNDS}):\n- ${unmet.join('\n- ')}\nResolve each, or state in your reply which item you are leaving and why, then stop.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
} catch { process.exit(0); }
