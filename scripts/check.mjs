#!/usr/bin/env node
// The one check a reviewer reruns: vendor hashes (which cover the built workflows), version agreement, the plugin manifest, the tests, the routing report.
// Every step runs with TMPDIR pointing at one per-run directory. The tests must remove their own scratch (scripts/scratch.mjs); when a step leaves
// anything behind, this run fails and lists it. A per-run parent is used instead of a before/after snapshot of the shared tmpdir, because a snapshot
// would blame this run for entries that other runs or tools create there meanwhile, and would only know the prefixes we remembered to list.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const root = join(dirname(new URL(import.meta.url).pathname), '..');
const keep = process.env.SFLOW_KEEP_TMP === '1';

const scratchRoot = mkdtempSync(join(tmpdir(), 'sflow-check-'));
process.on('exit', () => { if (!keep) rmSync(scratchRoot, { recursive: true, force: true }); });
for (const [sig, n] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.once(sig, () => process.exit(n));

const run = (cmd, args) => { console.log(`\n$ ${cmd} ${args.join(' ')}`); execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: scratchRoot } }); };
let failure;
try {
  run('node', ['scripts/vendor.mjs', 'check']);
  run('node', ['scripts/check-versions.mjs']);
  run('claude', ['plugin', 'validate', '.']);
  run('claude', ['plugin', 'validate', 'domains/flutter']);
  run('node', ['scripts/test-hooks.mjs']);
  run('node', ['scripts/test-eval-brake.mjs']);
  run('node', ['scripts/test-upstream.mjs']);
  run('node', ['scripts/test-vendor.mjs']);
  run('node', ['scripts/test-model-budget.mjs']);
  run('node', ['scripts/test-refresh-install.mjs']);
  run('node', ['scripts/test-plugin-root-space.mjs']);
  run('node', ['scripts/check-routing.mjs']);
} catch (err) { failure = err; }

const leaked = readdirSync(scratchRoot);
if (leaked.length) {
  console.error(`\nscratch leak: the steps left ${leaked.length} entr${leaked.length === 1 ? 'y' : 'ies'} in the per-run TMPDIR (${scratchRoot}):\n${leaked.map((n) => `  ${join(scratchRoot, n)}`).join('\n')}`);
  console.error(keep ? 'SFLOW_KEEP_TMP=1: left in place for debugging; this run still fails.' : 'Removed after this listing. Fix the test to clean up on every exit path (scripts/scratch.mjs).');
}
if (failure || leaked.length) {
  if (failure) console.error(`\ncheck failed: ${failure.message}`);
  process.exit(1);
}
console.log('\nall checks passed');
