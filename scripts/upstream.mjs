#!/usr/bin/env node
// Reports how far each vendored source has drifted from its upstream default branch. Read-only, network-only, no tokens.
//   node scripts/upstream.mjs          # text report
//   node scripts/upstream.mjs --json   # machine-readable report
// Exit codes: 0 = every source current, 10 = drift (some source behind), 1 = error (pin missing/unreachable, manifest/lock mismatch, network). Error beats drift.
// "Behind" counts only commits that touch the paths sflow vendors, so unrelated monorepo commits never trigger it.
// Each run fetches trees (no blobs) into a fresh temp dir, never the vendor cache, so a warm cache cannot hide a deleted SHA.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const short = (s) => s.slice(0, 12);
const uniq = (a) => [...new Set(a)];
const lines = (s) => s.split('\n').filter(Boolean);

const isWild = (entry) => entry.from.endsWith('/*');
const baseOf = (entry) => entry.from.replace(/\/\*$/, '');

// Pathspecs for the files this entry vendors. `include` lists the vendored children; `exclude` carves children out of a wildcard.
export function entryPathspecs(entry) {
  const base = baseOf(entry);
  if (entry.include?.length) return entry.include.map((c) => `${base}/${c}`);
  return [base, ...(isWild(entry) ? (entry.exclude ?? []).map((c) => `:(exclude)${base}/${c}`) : [])];
}

// Map a path in this repo back to the upstream path it was copied from, or null when the entry did not produce it.
export function localToUpstream(entry, local) {
  if (isWild(entry)) {
    if (!local.startsWith(entry.to + '/')) return null;
    const [seg, ...rest] = local.slice(entry.to.length + 1).split('/');
    const orig = Object.entries(entry.rename ?? {}).find(([, v]) => v === seg)?.[0] ?? seg;
    if (entry.include && !entry.include.includes(orig)) return null;
    if ((entry.exclude ?? []).includes(orig)) return null;
    return [baseOf(entry), orig, ...rest].join('/');
  }
  if (local === entry.to) return entry.from;
  if (local.startsWith(entry.to + '/')) return `${entry.from}/${local.slice(entry.to.length + 1)}`;
  return null;
}

// Names a wildcard entry vendors at `ref`: directories (and .md files for an agents/ destination), filtered by include/exclude.
function children(git, ref, entry) {
  const base = baseOf(entry);
  const out = git(['ls-tree', ref, `${base}/`]);
  return lines(out).map((l) => { const [meta, path] = l.split('\t'); return { type: meta.split(' ')[1], name: basename(path) }; })
    .filter((c) => c.type === 'tree' || (basename(entry.to) === 'agents' && c.name.endsWith('.md')))
    .map((c) => c.name)
    .filter((n) => !(entry.exclude ?? []).includes(n))
    .filter((n) => !entry.include || entry.include.includes(n));
}

function inspectSource({ name, src, lockSrc, entries, repo, head, branch, git, overlays, exists }) {
  const r = { source: name, repo: src.repo, pinned: src.sha, head: head.sha, branch, relevantAhead: null, totalAhead: null, status: 'current',
    compare: null, changed: [], newSkills: [], removedSkills: [], overlayFlags: [], errors: [] };
  if (!lockSrc) r.errors.push(`${name} is in the manifest but not in vendor.lock.json; run sync`);
  else if (lockSrc.sha !== src.sha) r.errors.push(`manifest/lock sha mismatch: manifest ${short(src.sha)}, lock ${short(lockSrc.sha)}; run sync`);
  if (/^https:\/\/github\.com\//.test(src.repo)) r.compare = `${src.repo.replace(/\.git$/, '')}/compare/${short(src.sha)}...${short(head.sha)}`;

  const ok = (args) => { try { git(args); return true; } catch { return false; } };
  if (!ok(['cat-file', '-e', `${src.sha}^{commit}`])) { r.errors.push(`pinned sha ${short(src.sha)} no longer exists upstream (deleted or force-pushed away)`); r.status = 'error'; return r; }
  if (!ok(['merge-base', '--is-ancestor', src.sha, head.sha])) { r.errors.push(`pinned sha ${short(src.sha)} is not an ancestor of ${branch ?? 'HEAD'} (${short(head.sha)}); history was rewritten`); r.status = 'error'; return r; }
  if (r.errors.length) r.status = 'error';

  const range = `${src.sha}..${head.sha}`;
  const specs = uniq(entries.flatMap(entryPathspecs));
  r.totalAhead = Number(git(['rev-list', '--count', range]).trim());
  r.relevantAhead = Number(git(['rev-list', '--count', range, '--', ...specs]).trim());
  if (r.relevantAhead === 0) return r;
  if (r.status !== 'error') r.status = 'behind';

  r.changed = lines(git(['diff', '--name-status', '--no-renames', src.sha, head.sha, '--', ...specs])).map((l) => { const [status, path] = l.split('\t'); return { status, path }; });

  for (const e of entries.filter(isWild)) {
    const before = children(git, src.sha, e), after = children(git, head.sha, e);
    const dest = (n) => join(e.to, e.rename?.[n] ?? n);
    for (const n of after.filter((x) => !before.includes(x))) r.newSkills.push({ entry: e.from, name: n, to: dest(n), collision: exists(dest(n)) });
    for (const n of before.filter((x) => !after.includes(x))) r.removedSkills.push({ entry: e.from, name: n, to: dest(n) });
  }

  // An overlay anchors on text inside one vendored file. If that file's upstream twin changed, the anchor may be stale.
  const changedPaths = new Set(r.changed.map((c) => c.path));
  for (const o of overlays) {
    for (const e of entries) {
      const up = localToUpstream(e, o.target);
      if (up && changedPaths.has(up)) r.overlayFlags.push({ overlay: o.overlay, target: o.target, upstream: up });
    }
  }
  return r;
}

// Pure: manifest + lock + an injected `openRepo(url)` -> { head, branch, git(args) } give the report. No clock, no network, no disk but `exists`.
export function buildReport({ manifest, lock, openRepo, overlays = [], exists = () => false }) {
  const byRepo = new Map();
  for (const [name, src] of Object.entries(manifest.sources)) byRepo.set(src.repo, [...(byRepo.get(src.repo) ?? []), name]);
  const sources = [];
  for (const [repo, names] of byRepo) {
    let handle, failure;
    try { handle = openRepo(repo); } catch (e) { failure = e; }   // one fetch per repo, however many source keys share it
    for (const name of names) {
      const src = manifest.sources[name];
      if (failure) {
        sources.push({ source: name, repo, pinned: src.sha, head: null, branch: null, relevantAhead: null, totalAhead: null, status: 'error', compare: null,
          changed: [], newSkills: [], removedSkills: [], overlayFlags: [], errors: [`cannot reach upstream: ${failure.message.split('\n')[0]}`] });
        continue;
      }
      const entries = manifest.entries.filter((e) => e.source === name);
      try {
        sources.push(inspectSource({ name, src, lockSrc: lock.sources?.[name], entries, repo, head: { sha: handle.head }, branch: handle.branch, git: handle.git, overlays, exists }));
      } catch (e) {
        sources.push({ source: name, repo, pinned: src.sha, head: handle.head, branch: handle.branch, relevantAhead: null, totalAhead: null, status: 'error', compare: null,
          changed: [], newSkills: [], removedSkills: [], overlayFlags: [], errors: [`git failed: ${e.message.split('\n')[0]}`] });
      }
    }
  }
  const count = (s) => sources.filter((x) => x.status === s).length;
  const summary = { current: count('current'), behind: count('behind'), error: count('error') };
  return { sources, summary, exitCode: summary.error ? 1 : summary.behind ? 10 : 0 };
}

export function formatText(report, { maxFiles = 25 } = {}) {
  const out = [];
  for (const s of report.sources) {
    out.push(`${s.source}  [${s.status.toUpperCase()}]`);
    out.push(`  repo      ${s.repo}`);
    out.push(`  pinned    ${short(s.pinned)}   head ${s.head ? short(s.head) : '?'}   branch ${s.branch ?? '?'}`);
    if (s.relevantAhead !== null) out.push(`  ahead     ${s.relevantAhead} relevant commit(s) on vendored paths, ${s.totalAhead} total`);
    if (s.compare && s.status !== 'current') out.push(`  compare   ${s.compare}`);
    for (const e of s.errors) out.push(`  ERROR     ${e}`);
    if (s.changed.length) {
      out.push(`  changed files (${s.changed.length}):`);
      for (const c of s.changed.slice(0, maxFiles)) out.push(`    ${c.status}  ${c.path}`);
      if (s.changed.length > maxFiles) out.push(`    ... and ${s.changed.length - maxFiles} more`);
    }
    for (const n of s.newSkills) out.push(`  NEW       ${n.entry} -> ${n.name} (would vendor to ${n.to})${n.collision ? '  COLLISION: that path already exists; add a rename' : ''}`);
    for (const n of s.removedSkills) out.push(`  REMOVED   ${n.entry} -> ${n.name} (vendored at ${n.to})`);
    for (const f of s.overlayFlags) out.push(`  OVERLAY   ${f.overlay} anchors in ${f.target}; upstream ${f.upstream} changed, re-check the anchors`);
    out.push('');
  }
  const m = report.summary;
  out.push(`${m.current} current, ${m.behind} behind, ${m.error} error  (exit ${report.exitCode})`);
  return out.join('\n');
}

// Overlay -> vendored file: `extends: X` is skills/poteto-mode/playbooks/X.md; `target:` is a path from the repo root (see build-workflows.mjs).
export function readOverlays(dir = root) {
  const wf = join(dir, 'workflows');
  if (!existsSync(wf)) return [];
  return readdirSync(wf).filter((f) => f.endsWith('.md')).sort().flatMap((f) => {
    const fm = readFileSync(join(wf, f), 'utf8').replace(/^﻿/, '').replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const field = (k) => fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'))?.[1].trim() ?? '';
    const target = field('target') || (field('extends') && `skills/poteto-mode/playbooks/${field('extends')}.md`);
    return target ? [{ overlay: `workflows/${f}`, target }] : [];
  });
}

// Real git: ls-remote for head + branch, then a fresh bare repo with trees only (no blobs) so path-filtered log and diff work and stay small.
function realOpenRepo() {
  const tmps = [];
  const open = (repo) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const run = (args, cwd) => execFileSync('git', cwd ? ['-C', cwd, ...args] : args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const ls = run(['ls-remote', '--symref', repo, 'HEAD']);
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(ls)?.[1] ?? null;
    const head = /^([0-9a-f]{40})\s+HEAD$/m.exec(ls)?.[1];
    if (!head) throw new Error(`git ls-remote ${repo} HEAD returned no commit`);
    const dir = mkdtempSync(join(tmpdir(), 'sflow-upstream-'));
    tmps.push(dir);
    run(['init', '-q', '--bare', dir]);
    run(['remote', 'add', 'origin', repo], dir);
    run(['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', head], dir);
    return { head, branch, git: (args) => run(args, dir) };
  };
  return { open, cleanup: () => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

function main() {
  const json = process.argv.includes('--json');
  const manifest = JSON.parse(readFileSync(join(root, 'vendor.manifest.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'vendor.lock.json'), 'utf8'));
  const real = realOpenRepo();
  let report;
  try {
    report = buildReport({ manifest, lock, openRepo: real.open, overlays: readOverlays(), exists: (p) => existsSync(join(root, p)) });
  } finally { real.cleanup(); }
  console.log(json ? JSON.stringify(report, null, 2) : formatText(report));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) main();
