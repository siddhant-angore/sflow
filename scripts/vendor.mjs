#!/usr/bin/env node
// Vendors the three sources by commit SHA into one flat skill tree, applies the workflow overlays, and pins everything with a hash lock.
//   node scripts/vendor.mjs sync   # fetch at the pinned shas, copy, rename collisions, build workflows, write vendor.lock.json + NOTICE.md
//   node scripts/vendor.mjs check  # re-hash every pinned file; exit 1 on drift or a missing file
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(readFileSync(join(root, 'vendor.manifest.json'), 'utf8'));
const lockPath = join(root, 'vendor.lock.json');
const mode = process.argv[2];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

function checkout(name) {
  const { repo, sha } = manifest.sources[name];
  const dir = join(tmpdir(), 'sflow-vendor', name.replace('/', '__'), sha);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
    git('init', '-q'); git('remote', 'add', 'origin', repo); git('fetch', '-q', '--depth', '1', 'origin', sha); git('checkout', '-q', 'FETCH_HEAD');
  }
  return dir;
}

function expand(srcRoot, entry) {
  if (!entry.from.endsWith('/*')) return [[join(srcRoot, entry.from), join(root, entry.to)]];
  const parent = join(srcRoot, entry.from.slice(0, -2));
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() || (basename(entry.to) === 'agents' && e.name.endsWith('.md')))
    .filter((e) => !(entry.exclude ?? []).includes(e.name))
    .map((e) => [join(parent, e.name), join(root, entry.to, entry.rename?.[e.name] ?? e.name)]);
}

// A skill's name is its directory. A renamed collision gets its frontmatter name rewritten so every host agrees.
function alignName(dir) {
  const f = join(dir, 'SKILL.md');
  if (!existsSync(f)) return;
  const text = readFileSync(f, 'utf8');
  const fixed = text.replace(/^name:[ \t]*.*$/m, `name: ${basename(dir)}`);
  if (fixed !== text) writeFileSync(f, fixed);
}

function sync() {
  const lock = { sources: manifest.sources, files: {} };
  for (const t of new Set(manifest.entries.map((e) => e.to))) rmSync(join(root, t), { recursive: true, force: true });
  const notice = ['# NOTICE', '', 'sflow is assembled from three MIT-licensed sources, vendored by commit and listed here with their licenses in `LICENSES/`. Do not edit vendored files in place; bump `vendor.manifest.json` and run `node scripts/vendor.mjs sync`. The workflow overlays in `workflows/` are the only sflow-authored change to those files, applied by `scripts/build-workflows.mjs`.', ''];
  const seen = new Map();
  for (const entry of manifest.entries) {
    const srcRoot = checkout(entry.source);
    for (const [from, to] of expand(srcRoot, entry)) {
      if (seen.has(to)) throw new Error(`collision: ${relative(root, to)} from ${seen.get(to)} and ${entry.source}; add a rename to the manifest`);
      seen.set(to, entry.source);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true, dereference: true });
      if (statSync(to).isDirectory() && basename(dirname(to)) === 'skills') alignName(to);
      notice.push(`- \`${relative(root, to)}\` from ${entry.source}@${manifest.sources[entry.source].sha.slice(0, 12)} (\`${entry.from}\`)`);
    }
    const lic = join(root, 'LICENSES', entry.source.replace('/', '__') + '.LICENSE');
    mkdirSync(dirname(lic), { recursive: true });
    cpSync(join(srcRoot, 'LICENSE'), lic);
    // Vendored skill dirs that are not SKILL.md skills (e.g. wingspan's shared/) are left as-is; Claude Code ignores them.
  }
  execFileSync('node', [join(root, 'scripts', 'build-workflows.mjs')], { stdio: 'inherit' });
  execFileSync('node', [join(root, 'scripts', 'check-domain-playbooks.mjs')], { stdio: 'inherit' });
  for (const t of new Set(manifest.entries.map((e) => e.to))) {
    const p = join(root, t);
    for (const f of statSync(p).isDirectory() ? walk(p) : [p]) lock.files[relative(root, f)] = sha256(f);
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(join(root, 'NOTICE.md'), notice.join('\n') + '\n');
  console.log(`vendored ${Object.keys(lock.files).length} files from ${Object.keys(manifest.sources).length} sources`);
}

function check() {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const problems = [];
  for (const [rel, want] of Object.entries(lock.files)) {
    const p = join(root, rel);
    if (!existsSync(p)) problems.push(`missing: ${rel}`);
    else if (sha256(p) !== want) problems.push(`drift: ${rel}`);
  }
  for (const t of new Set(manifest.entries.map((e) => e.to))) {
    const p = join(root, t);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    for (const f of walk(p)) { const rel = relative(root, f); if (!(rel in lock.files) && !basename(f).startsWith('.')) problems.push(`unexpected (not in lock): ${rel}`); }
  }
  for (const [name, src] of Object.entries(lock.sources)) if (manifest.sources[name]?.sha !== src.sha) problems.push(`manifest/lock sha mismatch for ${name}; run sync`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`vendor ok: ${Object.keys(lock.files).length} files`);
}

if (mode === 'sync') sync();
else if (mode === 'check') check();
else { console.error('usage: vendor.mjs sync|check'); process.exit(2); }
