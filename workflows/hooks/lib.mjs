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

// `git -C x -c k=v --no-pager push` becomes `git push`, so every rule matches the subcommand.
export const normalize = (cmd) => cmd.replace(/\bgit((\s+(-C|-c|--git-dir|--work-tree|--exec-path)(=|\s+)\S+)|\s+--no-pager|\s+--no-optional-locks)+\s+/g, 'git ');
export const segments = (cmd) => normalize(cmd).split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);

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

