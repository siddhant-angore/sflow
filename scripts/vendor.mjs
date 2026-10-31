#!/usr/bin/env node
// Vendors every source in vendor.manifest.json by commit SHA into one flat skill tree, applies the workflow overlays, and pins everything with a hash lock.
//   node scripts/vendor.mjs sync   # fetch at the pinned shas, copy, rename collisions, build workflows, write vendor.lock.json + NOTICE.md
//   node scripts/vendor.mjs check  # report symlinks, missing files, hash drift, unlocked (unexpected) files under vendored targets and manifest/lock sha mismatches; exit 1 on any
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

let root = join(dirname(new URL(import.meta.url).pathname), '..');
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

// cpSync({ dereference }) leaves nested symlinks as links into the tmp cache, so resolve every link by hand.
// A link that leaves the checkout, dangles, or points at a directory already on the current path (a loop) is an error. `seen` holds the real paths of the directories above `from`.
function copyResolved(from, to, srcRoot, source, seen = new Set()) {
  const isLink = lstatSync(from).isSymbolicLink();
  const linkText = () => (isLink ? readlinkSync(from) : realpathSync(from));
  let real;
  try { real = realpathSync(from); } catch (e) {
    if (isLink && e.code === 'ENOENT') throw new Error(`broken symlink in ${source}: ${relative(srcRoot, from)} -> ${readlinkSync(from)}`);
    if (isLink && e.code === 'ELOOP') throw new Error(`symlink loop in ${source}: ${relative(srcRoot, from)} -> ${readlinkSync(from)}`);
    throw e;
  }
  const top = realpathSync(srcRoot);
  if (real !== top && !real.startsWith(top + sep)) throw new Error(`${source}: symlink escapes the source checkout: ${from} -> ${real}`);
  if (statSync(real).isDirectory()) {
    if ([...seen].some((s) => s === real || s.startsWith(real + sep))) throw new Error(`symlink loop in ${source}: ${relative(srcRoot, from)} -> ${linkText()}`);
    const next = new Set([...seen, real]);
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) copyResolved(join(from, e), join(to, e), srcRoot, source, next);
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

function syncInPlace() {
  const lock = { sources: manifest.sources, files: {} };
  for (const t of new Set(manifest.entries.map((e) => e.to))) rmSync(join(root, t), { recursive: true, force: true });
  const sources = Object.entries(manifest.sources);
  const sourceLine = ([name, s]) => `- ${name} (${s.license}), ${s.repo}@${s.sha.slice(0, 12)}, license in \`LICENSES/${licenseName(name)}\`${s.note ? `. ${s.note}` : ''}`;
  const notice = ['# NOTICE', '', `sflow is assembled from ${sources.length} vendored sources, pinned by commit. Each source's license text is in \`LICENSES/\`. Do not edit vendored files in place; bump \`vendor.manifest.json\` and run \`node scripts/vendor.mjs sync\`. The workflow overlays in \`workflows/\` are the only sflow-authored change to those files, applied by \`scripts/build-workflows.mjs\`.`, '', '## Sources', '', ...sources.map(sourceLine), '', '## Files', ''];
  const seen = new Map();
  for (const entry of manifest.entries) {
    const srcRoot = checkout(entry.source);
    for (const [from, to] of expand(srcRoot, entry)) {
      if (seen.has(to)) throw new Error(`collision: ${relative(root, to)} from ${seen.get(to)} and ${entry.source}; add a rename to the manifest`);
      seen.set(to, entry.source);
      mkdirSync(dirname(to), { recursive: true });
      const top = entry.from.endsWith('/*') ? null : entry.include;
      if (top) { mkdirSync(to,{recursive:true}); for (const e of readdirSync(from)) if (top.includes(e)) copyResolved(join(from,e), join(to,e), srcRoot, entry.source); } else copyResolved(from, to, srcRoot, entry.source);
      if (statSync(to).isDirectory() && basename(dirname(to)) === 'skills') alignName(to);
      notice.push(`- \`${relative(root, to)}\` from ${entry.source}@${manifest.sources[entry.source].sha.slice(0, 12)} (\`${entry.from}\`)`);
    }
    const lic = join(root, 'LICENSES', licenseName(entry.source));
    mkdirSync(dirname(lic), { recursive: true });
    cpSync(join(srcRoot, manifest.sources[entry.source].licensePath ?? 'LICENSE'), lic);
    // Vendored skill dirs that are not SKILL.md skills (e.g. wingspan's shared/) are left as-is; Claude Code ignores them.
  }
  execFileSync('node', [join(root, 'scripts', 'build-workflows.mjs')], { stdio: 'inherit' });
  execFileSync('node', [join(root, 'scripts', 'check-domain-playbooks.mjs')], { stdio: 'inherit' });
  for (const t of new Set(manifest.entries.map((e) => e.to))) {
    const p = join(root, t);
    for (const f of statSync(p).isDirectory() ? walk(p) : [p]) lock.files[relative(root, f)] = sha256(f);
  }
  writeFileSync(join(root, 'vendor.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(join(root, 'NOTICE.md'), notice.join('\n') + '\n');
  console.log(`vendored ${Object.keys(lock.files).length} files from ${Object.keys(manifest.sources).length} sources`);
}

// Build in a staging copy and swap the outputs in only on success, so a failed fetch, copy or overlay no longer leaves targets half-deleted.
function sync() {
  const real = root, stage = mkdtempSync(join(tmpdir(), 'sflow-vendor-stage-'));
  try {
    cpSync(real, stage, { recursive: true, verbatimSymlinks: true, filter: (f) => !['.git', 'node_modules'].includes(relative(real, f).split(sep)[0]) });
    root = stage;
    try { syncInPlace(); } finally { root = real; }
    const outs = [...new Set([...manifest.entries.map((e) => e.to), 'LICENSES', 'NOTICE.md', 'vendor.lock.json', 'hooks'])];
    for (const p of outs.filter((p) => !outs.some((q) => q !== p && p.startsWith(q + '/')))) {
      rmSync(join(real, p), { recursive: true, force: true });
      if (existsSync(join(stage, p))) cpSync(join(stage, p), join(real, p), { recursive: true, verbatimSymlinks: true });
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
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
    for (const f of walk(p)) { const rel = relative(root, f); if (lstatSync(f).isSymbolicLink() && !(rel in lock.files)) problems.push(`symlink: ${rel}`); else if (!(rel in lock.files) && !basename(f).startsWith('.')) problems.push(`unexpected (not in lock): ${rel}`); }
  }
  for (const [name, src] of Object.entries(lock.sources)) if (manifest.sources[name]?.sha !== src.sha) problems.push(`manifest/lock sha mismatch for ${name}; run sync`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`vendor ok: ${Object.keys(lock.files).length} files`);
}

if (mode === 'sync') sync();
else if (mode === 'check') check();
else { console.error('usage: vendor.mjs sync|check'); process.exit(2); }
