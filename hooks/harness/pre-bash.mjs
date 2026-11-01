// PreToolUse(Bash): guard first (irreversible git and release actions), then the push gate from .harness.json.
// Any internal error denies: the hook fails closed.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { config, currentBranch, deny, GATE_RECORD_DIR, git, gitDir, HOOK_FILE_DENY, hookFileName, hookFileReason, isPolicyPath, NO_REPLACE_ENV, PLACEHOLDER, policyDeny, policyNote, pushSecretScan, readEvent, record, segments } from './lib.mjs';
import { analyzeWrites, envReason, reason, retargets } from './guard-rules.mjs';

const ev = readEvent();
if (ev.tool_name !== 'Bash') process.exit(0);
const cmd = String(ev.tool_input?.command ?? '');
try {
  const cfg = config(ev.cwd);
  // SID-82/83: a committed policy that exists but can't be used fails closed exactly as a parse error always did: every command is denied
  // (nothing that was denied becomes allowed), now with the reason and who fixes it instead of a bare exception.
  if (cfg.broken) { deny(`harness hook error (failing closed): ${policyNote(cfg)}. Every shell command is blocked until then; ask a human to fix .harness.json on origin/${cfg.broken.base} (PR, merge) and run git fetch origin in this checkout.`); process.exit(0); }
  // Branch unknown (null) when there is no root, or the command retargets git at another repo or dir: the hook cwd's branch is not the one pushed, so a push must name its branch.
  const branch = cfg.root && !retargets(cmd) ? currentBranch(cfg.root) : null; // no root: git can't read the repo (or there is none), so the guard still runs with strict defaults
  const env = envReason(cmd);
  if (env) { deny(`harness guard: ${env}\n  ${policyNote(cfg)}`); process.exit(0); }
  // SID-66: no shell write to a policy file. Runs on the whole command (segments() splits inside quotes), whether or not a policy is committed.
  const w = analyzeWrites(cmd);
  const line = cmd.split('\n')[0].slice(0, 200);
  if (w.hit) { deny(`harness guard: ${policyDeny(w.hit)}\n  in: ${line}\n  ${policyNote(cfg)}`); process.exit(0); }
  // Defence in depth: a write through an existing symlink whose real path is a policy file.
  for (const t of w.through) {
    if (t.includes('$')) continue;
    let real = null;
    try { real = realpathSync(resolve(ev.cwd ?? cfg.root ?? process.cwd(), t.replace(/^~(?=\/|$)/, homedir()))); } catch {}
    if (real && isPolicyPath(real)) { deny(`harness guard: ${t} is a symlink to ${policyDeny(real)}\n  in: ${line}\n  ${policyNote(cfg)}`); process.exit(0); }
  }
  // SID-162: a write, link end or chmod/chown that lands in a hooks dir through a symlink (dangling too) or a hardlink. Git config and .git/info shell writes keep
  // their own rules in envReason (config denied; .git/info only when a git command follows), so only the hooks verdict denies here.
  // hookFileReason throws on a git error, which the catch below turns into a deny.
  for (const t of [...w.through, ...w.links, ...w.modes]) {
    if (t.includes('$')) continue;
    const tp = t.replace(/^~(?=\/|$)/, homedir()), at = ev.cwd ?? cfg.root ?? process.cwd();
    let why; try { why = hookFileReason(tp, at); } catch { why = hookFileName(tp, at)?.why; } // git can't read the repo (shell writes there stay allowed as before): the name check still holds; a path that can't be resolved throws and denies
    if (why === HOOK_FILE_DENY) { deny(`harness guard: ${why}\n  (${t} resolves into a hooks dir)\n  in: ${line}\n  ${policyNote(cfg)}`); process.exit(0); }
  }
  // A policy-named source copied into a directory lands as <dir>/<name>. Copying FROM a policy file is a read: deny only when that landing is the repo-root .harness.json or a .claude/settings*.json. Dir = trailing slash, ., .., -t, or an existing directory; resolved against the event cwd (and any `cd` earlier in the command).
  const tilde = (x) => x.replace(/^~(?=\/|$)/, homedir());
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  // No root (git can't read the repo, or there is none): the cwd stands in for the root, so copies onto ./.harness.json are refused and copies out (cp .harness.json /tmp/) stay allowed.
  // No work tree (cwd inside .git, or core.bare): cfg.root is the git dir, so the work tree is its parent when it is named .git, else the cwd.
  const rootDir = cfg.noWorkTree ? (basename(cfg.root) === '.git' ? dirname(cfg.root) : resolve(ev.cwd ?? process.cwd())) : cfg.root ?? resolve(ev.cwd ?? process.cwd());
  const rootPolicy = [rootDir, real(rootDir)].map((r) => resolve(r, '.harness.json').toLowerCase());
  const landsOnPolicy = (p) => rootPolicy.includes(p.toLowerCase()) || (isPolicyPath(p) && !/\.harness\.json$/i.test(p));
  for (const { dest, names, dir, cds } of w.into) {
    if (dest.includes('$') || cds.some((c) => c.includes('$'))) continue;
    const start = resolve(ev.cwd ?? cfg.root ?? process.cwd());
    for (const from of cds.length ? [start, resolve(start, ...cds.map(tilde))] : [start]) {
      const abs = resolve(from, tilde(dest));
      let isDir = dir;
      if (!isDir) { try { isDir = statSync(abs).isDirectory(); } catch {} }
      const n = isDir ? names.find((x) => landsOnPolicy(join(abs, x)) || landsOnPolicy(join(real(abs), x))) : null;
      if (n) { const joined = join(dest, n); deny(`harness guard: ${policyDeny(joined)}\n  ("${dest}" is an existing directory, so this writes ${joined})\n  in: ${line}\n  ${policyNote(cfg)}`); process.exit(0); }
    }
  }
  const segs = segments(cmd);
  for (const seg of segs) {
    const why = reason(seg, cfg, branch);
    if (why) { deny(`harness guard: ${why}\n  in: ${seg}\n  ${policyNote(cfg)}`); process.exit(0); }
  }
  if (!cfg.root) process.exit(0); // nothing to gate without a repository

  const pushes = segs.some((s) => /^git\s+push\b|^gh\s+pr\s+(create|ready)\b/.test(s));
  if (!pushes || !cfg.present) process.exit(0);
  if (cfg.noWorkTree) { deny('harness gate: git sees no work tree here (the shell is inside .git, or core.bare is set), so the gate can\'t check what you push; run the push from the repository\'s work tree (cd to its root). If core.bare is set on a normal checkout, ask a human to fix the repo config.'); process.exit(0); }
  if (segs.some((s) => /^git\s+(add|commit)\b/.test(s))) { deny('harness gate: commit in one command and push in the next, so the gate checks the commit it records'); process.exit(0); }
  if (git(cfg.root, 'status', '--porcelain', '--untracked-files=no')) { deny('harness gate: tracked changes are uncommitted; commit them first so the gate checks what you push'); process.exit(0); }
  if (cfg.gate.some((c) => c.includes(PLACEHOLDER))) { deny(`harness gate: .harness.json still has the placeholder gate; set the project checks on ${cfg.source}`); process.exit(0); }
  const head = git(cfg.root, 'rev-parse', 'HEAD');
  const dir = join(gitDir(cfg.root), GATE_RECORD_DIR);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, head))) process.exit(0);
  const mergeBase = cfg.baseSha ? (() => { try { return git(cfg.root, '-c', 'core.commitGraph=false', 'merge-base', 'HEAD', cfg.baseSha); } catch { return null; } })() : null;
  const base = mergeBase ?? cfg.baseSha; // a sha, never a ref name: names can be shadowed by tags and branches. A present policy implies a verified baseSha, so there is no further fallback.
  const deadline = Date.now() + 840_000;
  const log = (line) => { const [result, ms, ...cmd] = line.split(' '); record(cfg.root, { kind: 'gate', head: head.slice(0, 12), result, ms: Number(ms) || null, command: cmd.join(' ') }); };
  const scan = pushSecretScan(cfg.root, base);
  if (scan) { log(`${scan.result} 0 ${scan.detail}`); deny(scan.reason); process.exit(0); }
  for (const raw of cfg.gate) {
    const command = raw.replaceAll('{base}', base);
    const started = Date.now();
    try {
      execSync(command, { cwd: cfg.root, stdio: ['ignore', 'pipe', 'pipe'], env: NO_REPLACE_ENV, timeout: Math.max(1000, deadline - Date.now()), maxBuffer: 256 << 20 });
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
