#!/usr/bin/env node
// The one check a reviewer reruns: vendor hashes (which cover the built workflows), version agreement, the plugin manifest, the tests, the routing report.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const root = join(dirname(new URL(import.meta.url).pathname), '..');
const run = (cmd, args) => { console.log(`\n$ ${cmd} ${args.join(' ')}`); execFileSync(cmd, args, { cwd: root, stdio: 'inherit' }); };
run('node', ['scripts/vendor.mjs', 'check']);
run('node', ['scripts/check-versions.mjs']);
run('claude', ['plugin', 'validate', '.']);
run('claude', ['plugin', 'validate', 'domains/flutter']);
run('node', ['scripts/test-hooks.mjs']);
run('node', ['scripts/test-eval-brake.mjs']);
run('node', ['scripts/test-upstream.mjs']);
run('node', ['scripts/test-vendor.mjs']);
run('node', ['scripts/test-git-hooks.mjs']);
run('node', ['scripts/check-routing.mjs']);
console.log('\nall checks passed');
