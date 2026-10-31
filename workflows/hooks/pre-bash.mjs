// PreToolUse(Bash): guard first (irreversible git and release actions), then the push gate from .harness.json.
// Any internal error denies: the hook fails closed.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, currentBranch, deny, git, gitDir, PLACEHOLDER, policyNote, readEvent, record, segments } from './lib.mjs';
import { envReason, reason } from './guard-rules.mjs';

const ev = readEvent();
if (ev.tool_name !== 'Bash') process.exit(0);
const cmd = String(ev.tool_input?.command ?? '');
try {
  const cfg = config(ev.cwd);
  if (!cfg.root) process.exit(0);
  const branch = currentBranch(cfg.root);
  const env = envReason(cmd);
  if (env) { deny(`harness guard: ${env}\n  ${policyNote(cfg)}`); process.exit(0); }
  const segs = segments(cmd);
  for (const seg of segs) {
    const why = reason(seg, cfg, branch);
    if (why) { deny(`harness guard: ${why}\n  in: ${seg}\n  ${policyNote(cfg)}`); process.exit(0); }
  }

  const pushes = segs.some((s) => /^git\s+push\b|^gh\s+pr\s+(create|ready)\b/.test(s));
  if (!pushes || !cfg.present) process.exit(0);
  if (segs.some((s) => /^git\s+(add|commit)\b/.test(s))) { deny('harness gate: commit in one command and push in the next, so the gate checks the commit it records'); process.exit(0); }
  if (git(cfg.root, 'status', '--porcelain', '--untracked-files=no')) { deny('harness gate: tracked changes are uncommitted; commit them first so the gate checks what you push'); process.exit(0); }
  if (cfg.gate.some((c) => c.includes(PLACEHOLDER))) { deny(`harness gate: .harness.json still has the placeholder gate; set the project checks on ${cfg.source}`); process.exit(0); }
  const head = git(cfg.root, 'rev-parse', 'HEAD');
  const dir = join(gitDir(cfg.root), 'harness-gate');
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, head))) process.exit(0);
  const base = (() => { try { return git(cfg.root, 'merge-base', 'HEAD', `origin/${cfg.base}`); } catch { return null; } })();
  const deadline = Date.now() + 840_000;
  const log = (line) => { const [result, ms, ...cmd] = line.split(' '); record(cfg.root, { kind: 'gate', head: head.slice(0, 12), result, ms: Number(ms) || null, command: cmd.join(' ') }); };
  const secret = base ? secretHits(cfg.root, base) : [];
  if (secret.length) { log(`secret 0 ${secret.join(',')}`); deny(`harness gate: committed text looks like a secret (${secret.join(', ')}); remove it and rewrite the commit before pushing`); process.exit(0); }
  for (const raw of cfg.gate) {
    const command = raw.replaceAll('{base}', base ?? `origin/${cfg.base}`);
    const started = Date.now();
    try {
      execSync(command, { cwd: cfg.root, stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1000, deadline - Date.now()), maxBuffer: 256 << 20 });
      log(`pass ${Date.now() - started} ${command}`);
    } catch (e) {
      log(`fail ${Date.now() - started} ${command}`);
      const tail = [e.stdout, e.stderr].map((b) => (b ? b.toString() : '')).join('\n').trim().split('\n').slice(-40).join('\n');
      deny(`harness gate failed: \`${command}\`\n${tail}\nFix the cause (not the gate), commit, then push again.`);
      process.exit(0);
    }
  }
  writeFileSync(join(dir, head), new Date().toISOString() + '\n');
} catch (e) {
  deny(`harness hook error (failing closed): ${e.message}`);
}

function secretHits(root, base) {
  const patterns = [
    ['private key', /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/],
    ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
    ['Anthropic/OpenAI key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
    ['Linear key', /\blin_api_[A-Za-z0-9]{20,}\b/],
  ];
  let diff = '';
  try { diff = execSync(`git diff ${base}..HEAD -- . ':(exclude)*.lock' ':(exclude)*.snap'`, { cwd: root, maxBuffer: 256 << 20 }).toString(); } catch { return []; }
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  return patterns.filter(([, re]) => re.test(added)).map(([n]) => n);
}
