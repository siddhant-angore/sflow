#!/usr/bin/env node
// Vendors every source in vendor.manifest.json by commit SHA into one flat skill tree, applies the workflow overlays, and pins everything with a hash lock.
//   node scripts/vendor.mjs sync   # fetch at the pinned shas, copy, rename collisions, build workflows, write vendor.lock.json + NOTICE.md
//   node scripts/vendor.mjs check  # re-hash every pinned file; exit 1 on drift or a missing file
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(readFileSync(join(root, 'vendor.manifest.json'), 'utf8'));
const lockPath = join(root, 'vendor.lock.json');
const mode = process.argv[2];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

// A source key is a license scope, not always a repo: several keys may share one repo and sha (cursor/plugins ships one license per plugin subtree).
// The checkout is keyed by repo URL + sha so those keys share one fetch.
const repoSlug = (repo) => new URL(repo).pathname.replace(/^\/|\.git$/g, '').replaceAll('/', '__');
const licenseName = (name) => name.replaceAll('/', '__') + '.LICENSE';

// First sentence of NOTICE.md line 3, computed from the manifest. sync writes it and check compares against it, so the counts cannot go stale.
function noticeLead() {
  const counts = new Map();
  for (const s of Object.values(manifest.sources)) counts.set(s.license, (counts.get(s.license) ?? 0) + 1);
  const breakdown = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, n]) => `${n} ${l}`).join(', ');
  return `sflow is assembled from ${Object.keys(manifest.sources).length} vendored sources (${breakdown}), pinned by commit.`;
}

function checkout(name) {
  const { repo, sha } = manifest.sources[name];
  const dir = join(tmpdir(), 'sflow-vendor', repoSlug(repo), sha);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
    git('init', '-q'); git('remote', 'add', 'origin', repo); git('fetch', '-q', '--depth', '1', 'origin', sha); git('checkout', '-q', 'FETCH_HEAD');
  }
  return dir;
}

// cpSync({ dereference }) leaves nested symlinks as links into the tmp cache, so resolve every link by hand. A link whose target leaves the checkout is an error.
function copyResolved(from, to, srcRoot) {
  const real = realpathSync(from);
  const top = realpathSync(srcRoot);
  if (real !== top && !real.startsWith(top + sep)) throw new Error(`symlink escapes the source checkout: ${from} -> ${real}`);
  if (statSync(real).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) copyResolved(join(from, e), join(to, e), srcRoot);
  } else copyFileSync(real, to);
}

// `include` narrows an entry to named children, so one entry can take a few files or skills from a larger tree.
// `exclude` does the opposite. On a `/*` entry the names are children's file names; on a directory entry they are its top-level names.
function expand(srcRoot, entry) {
  if (!entry.from.endsWith('/*')) return [[join(srcRoot, entry.from), join(root, entry.to)]];
  const parent = join(srcRoot, entry.from.slice(0, -2));
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() || (basename(entry.to) === 'agents' && e.name.endsWith('.md')))
    .filter((e) => !(entry.exclude ?? []).includes(e.name))
    .filter((e) => !entry.include || entry.include.includes(e.name))
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
  const sources = Object.entries(manifest.sources);
  const sourceLine = ([name, s]) => `- ${name} (${s.license}), ${s.repo}@${s.sha.slice(0, 12)}, license in \`LICENSES/${licenseName(name)}\`${s.note ? `. ${s.note}` : ''}`;
  const notice = ['# NOTICE', '', `${noticeLead()} Each source's license text is in \`LICENSES/\`. Do not edit vendored files in place; bump \`vendor.manifest.json\` and run \`node scripts/vendor.mjs sync\`. The workflow overlays in \`workflows/\` are the only sflow-authored change to those files, applied by \`scripts/build-workflows.mjs\`.`, '', '## Sources', '', ...sources.map(sourceLine), '', '## Files', ''];
  const seen = new Map();
  for (const entry of manifest.entries) {
    const srcRoot = checkout(entry.source);
    for (const [from, to] of expand(srcRoot, entry)) {
      if (seen.has(to)) throw new Error(`collision: ${relative(root, to)} from ${seen.get(to)} and ${entry.source}; add a rename to the manifest`);
      seen.set(to, entry.source);
      mkdirSync(dirname(to), { recursive: true });
      const top = entry.from.endsWith('/*') ? null : entry.include;
      if (top) { mkdirSync(to,{recursive:true}); for (const e of readdirSync(from)) if (top.includes(e)) copyResolved(join(from,e), join(to,e), srcRoot); } else copyResolved(from, to, srcRoot);
      if (statSync(to).isDirectory() && basename(dirname(to)) === 'skills') alignName(to);
      notice.push(`- \`${relative(root, to)}\` from ${entry.source}@${manifest.sources[entry.source].sha.slice(0, 12)} (\`${entry.from}\`)`);
    }
    // Vendored skill dirs that are not SKILL.md skills (e.g. wingspan's shared/) are left as-is; Claude Code ignores them.
  }
  mkdirSync(join(root, 'LICENSES'), { recursive: true });
  for (const name of Object.keys(manifest.sources)) cpSync(join(checkout(name), manifest.sources[name].licensePath ?? 'LICENSE'), join(root, 'LICENSES', licenseName(name)));
  const owned = new Set(Object.keys(manifest.sources).map(licenseName));
  for (const f of readdirSync(join(root, 'LICENSES'))) if (f.endsWith('.LICENSE') && !owned.has(f)) { rmSync(join(root, 'LICENSES', f)); console.log(`removed orphan license: LICENSES/${f}`); }
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
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) problems.push(`symlink: ${rel}`);
    else if (!existsSync(p)) problems.push(`missing: ${rel}`);
    else if (sha256(p) !== want) problems.push(`drift: ${rel}`);
  }
  for (const t of new Set(manifest.entries.map((e) => e.to))) {
    const p = join(root, t);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    for (const f of walk(p)) { const rel = relative(root, f); if (lstatSync(f).isSymbolicLink() && !(rel in lock.files)) problems.push(`symlink: ${rel}`); if (!(rel in lock.files) && !basename(f).startsWith('.')) problems.push(`unexpected (not in lock): ${rel}`); }
  }
  for (const [name, src] of Object.entries(lock.sources)) if (manifest.sources[name]?.sha !== src.sha) problems.push(`manifest/lock sha mismatch for ${name}; run sync`);
  const licDir = join(root, 'LICENSES');
  const owned = new Set(Object.keys(manifest.sources).map(licenseName));
  for (const name of Object.keys(manifest.sources)) if (!existsSync(join(licDir, licenseName(name)))) problems.push(`missing license: LICENSES/${licenseName(name)} for ${name}`);
  for (const f of existsSync(licDir) ? readdirSync(licDir) : []) if (f.endsWith('.LICENSE') && !owned.has(f)) problems.push(`orphan license: LICENSES/${f} (no manifest source)`);
  const noticeLine = readFileSync(join(root, 'NOTICE.md'), 'utf8').split('\n')[2] ?? '';
  if (!noticeLine.startsWith(noticeLead() + ' ')) problems.push(`stale NOTICE.md header: line 3 must start with "${noticeLead()}"; run sync`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`vendor ok: ${Object.keys(lock.files).length} files`);
}

if (mode === 'sync') sync();
else if (mode === 'check') check();
else { console.error('usage: vendor.mjs sync|check'); process.exit(2); }
