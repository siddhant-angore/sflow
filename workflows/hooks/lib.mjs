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
export const NO_REPLACE_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
export function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: NO_REPLACE_ENV }).toString().trim();
}

export function repoRoot(cwd = process.cwd()) {
  try { return git(cwd, 'rev-parse', '--show-toplevel'); } catch { return null; }
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
// closed: strict defaults (merges denied, no gate, no Stop items) and present is false. Parse errors throw; pre-bash denies on throw.
export function config(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (!root) return { ...DEFAULTS, root: null, present: false };
  const candidates = baseCandidates(root);
  let text = null, source = null, base = null, baseSha = null;
  for (const b of candidates) {
    const sha = remoteSha(root, b);
    if (!sha) continue;
    try { text = git(root, 'show', `${sha}:.harness.json`); source = `origin/${b}`; base = b; baseSha = sha; break; } catch {}
  }
  if (text === null) {
    const head = remoteDefault(root);
    return { ...DEFAULTS, protectedBranches: [...new Set([...DEFAULTS.protectedBranches, head].filter(Boolean))], allowMerge: false, gate: [], dod: [], root, present: false, source: null, base: head ?? 'main', baseSha: remoteSha(root, head ?? 'main'), candidates, ignoredLocal: existsSync(join(root, '.harness.json')) };
  }
  const parsed = JSON.parse(text);
  // A non-array protectedBranches is dropped. The base branch must itself be protected, or an agent could push a new policy there; [] (solo repo) is kept.
  let protectedBranches = Array.isArray(parsed.protectedBranches) ? parsed.protectedBranches : DEFAULTS.protectedBranches;
  if (protectedBranches.length && !protectedBranches.includes(base)) protectedBranches = [...protectedBranches, base];
  return { ...DEFAULTS, ...parsed, protectedBranches, root, present: true, source, base, baseSha, candidates };
}

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADOPT = (base) => ` The working-tree .harness.json is NOT trusted until it is on origin/${base}: a human commits it on a branch (start from ${join(pluginRoot, 'templates', 'harness.json')}), opens a PR, merges it into ${base}, then run git fetch origin.`;

// One line saying which policy is in force, for deny messages.
export const policyNote = (cfg) => cfg.present
  ? `policy: .harness.json on origin/${cfg.base}`
  : `policy: none committed on origin (checked ${cfg.candidates.map((b) => `origin/${b}`).join(', ')}); strict defaults, protected: ${cfg.protectedBranches.join(', ')}, merges denied.${cfg.ignoredLocal ? ADOPT(cfg.base) : ''}`;
export const ignoredNote = (cfg) => `The working-tree .harness.json is ignored: no policy is committed on origin (checked ${cfg.candidates.map((b) => `origin/${b}`).join(', ')}), so strict defaults apply (protected: ${cfg.protectedBranches.join(', ')}, merges denied, no gate).${ADOPT(cfg.base)}`;

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

