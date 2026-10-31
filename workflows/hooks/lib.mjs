import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Full ref names throughout: `origin/<b>` would resolve refs/tags/origin/<b> or refs/heads/origin/<b> first, and an agent can create both.
const REMOTE = 'refs/remotes/origin/';
export const remoteDefault = (root) => { try { const r = git(root, 'symbolic-ref', `${REMOTE}HEAD`); return r.startsWith(REMOTE) ? r.slice(REMOTE.length) || null : null; } catch { return null; } };
export const baseCandidates = (root) => [...new Set([remoteDefault(root), 'main', 'master'].filter(Boolean))];

// The policy is the .harness.json committed on origin's base branch: origin/HEAD's branch, then main, then master.
// The working tree is never read as policy, so an agent edit changes nothing. With no committed policy the config fails
// closed: strict defaults (merges denied, no gate, no Stop items) and present is false. Parse errors throw; pre-bash denies on throw.
export function config(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (!root) return { ...DEFAULTS, root: null, present: false };
  const candidates = baseCandidates(root);
  let text = null, source = null, base = null;
  for (const b of candidates) {
    try { text = git(root, 'show', `${REMOTE}${b}:.harness.json`); source = `origin/${b}`; base = b; break; } catch {}
  }
  if (text === null) {
    const head = remoteDefault(root);
    return { ...DEFAULTS, protectedBranches: [...new Set([...DEFAULTS.protectedBranches, head].filter(Boolean))], allowMerge: false, gate: [], dod: [], root, present: false, source: null, base: head ?? 'main', candidates, ignoredLocal: existsSync(join(root, '.harness.json')) };
  }
  const parsed = JSON.parse(text);
  // A non-array protectedBranches is dropped. The base branch must itself be protected, or an agent could push a new policy there; [] (solo repo) is kept.
  let protectedBranches = Array.isArray(parsed.protectedBranches) ? parsed.protectedBranches : DEFAULTS.protectedBranches;
  if (protectedBranches.length && !protectedBranches.includes(base)) protectedBranches = [...protectedBranches, base];
  return { ...DEFAULTS, ...parsed, protectedBranches, root, present: true, source, base, candidates };
}

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADOPT = (base) => ` The working-tree .harness.json is NOT trusted until it is on origin/${base}: a human commits it on a branch (start from ${join(pluginRoot, 'templates', 'harness.json')}), opens a PR, merges it into ${base}, then run git fetch origin.`;

// One line saying which policy is in force, for deny messages.
export const policyNote = (cfg) => cfg.present
  ? `policy: .harness.json on origin/${cfg.base}`
  : `policy: none committed on origin (checked ${cfg.candidates.map((b) => `origin/${b}`).join(', ')}); strict defaults, protected: ${cfg.protectedBranches.join(', ')}, merges denied.${cfg.ignoredLocal ? ADOPT(cfg.base) : ''}`;
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

