// Offline tests for scripts/refresh-install.mjs (SID-144): fake Claude configs, a local marketplace clone and bare repo, and a stub `claude`.
// Run: node scripts/test-refresh-install.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch as makeScratch } from './scratch.mjs';

const script = new URL('./refresh-install.mjs', import.meta.url).pathname;
const sh = (cwd, c) => execFileSync('sh', ['-c', c], { cwd, stdio: 'pipe' }).toString().trim();
const run = (args, env = {}) => { const r = spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); return { status: r.status, out: r.stdout + r.stderr }; };

// origin (bare) with main at A then B, and a branch commit F; a marketplace clone of it.
const root = makeScratch('refresh-install-');
sh(root, 'git init -q -b main src && cd src && git config user.email t@t && git config user.name t && echo 1 > f && git add f && git commit -qm a && git rev-parse HEAD > ../A && echo 2 > f && git commit -qam b && git rev-parse HEAD > ../B && git checkout -q -b feat/x && echo 3 > f && git commit -qam f && git rev-parse HEAD > ../F && git checkout -q main && git clone -q --bare . ../origin.git');
const [A, B, F] = ['A', 'B', 'F'].map((x) => readFileSync(join(root, x), 'utf8').trim());
const remote = `file://${join(root, 'origin.git')}`;
const clone = (name, at) => { const d = join(root, name); sh(root, `git clone -q ${remote} ${name} && cd ${name} && git checkout -q ${at}`); return d; };

const config = (name, { sha = B, plugins = ['sflow', 'sflow-flutter'], source = { source: 'github', repo: 'siddhant-angore/sflow' }, cloneAt = B, cache = true } = {}) => {
  const c = join(root, name), p = join(c, 'plugins');
  mkdirSync(p, { recursive: true });
  const loc = clone(`${name}-mp`, cloneAt);
  writeFileSync(join(p, 'known_marketplaces.json'), JSON.stringify({ sflow: { source, installLocation: loc } }));
  const entries = Object.fromEntries(plugins.map((x) => { const ip = join(p, 'cache', 'sflow', x, '0.5.0'); if (cache) mkdirSync(ip, { recursive: true }); return [`${x}@sflow`, [{ scope: 'user', installPath: ip, version: '0.5.0', gitCommitSha: sha }]]; }));
  writeFileSync(join(p, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { ...entries, 'other@else': [{ gitCommitSha: 'x' }] } }));
  return { c, loc };
};

// check
let r = run(['check', '--config', config('ok').c, '--remote', remote]);
assert.equal(r.status, 0, `installed from main passes: ${r.out}`); assert.match(r.out, /ok\s+sflow@sflow/); assert.match(r.out, /ok\s+sflow-flutter@sflow/);
assert.equal(run(['check', '--config', join(root, 'ok'), '--expect', B]).status, 0, '--expect skips the network');
r = run(['check', '--config', config('stale', { sha: A }).c, '--remote', remote]);
assert.equal(r.status, 1, 'an older main commit fails'); assert.match(r.out, /MISMATCH sflow@sflow/); assert.match(r.out, new RegExp(`installed from ${A}, not main ${B}`));
r = run(['check', '--config', config('branch', { sha: F }).c, '--remote', remote]);
assert.equal(r.status, 1, 'a branch commit fails'); assert.match(r.out, new RegExp(F));
r = run(['check', '--config', join(root, 'ok'), '--config', join(root, 'stale'), '--remote', remote]);
assert.equal(r.status, 1, 'one stale config of two fails'); assert.match(r.out, /stale: sflow@sflow/); assert.doesNotMatch(r.out, /\/ok: sflow@sflow is installed/);
r = run(['check', '--config', config('none', { plugins: [] }).c, '--expect', B]);
assert.equal(r.status, 1, 'no sflow plugin fails'); assert.match(r.out, /no \*@sflow plugin installed/);
mkdirSync(join(root, 'empty'));
r = run(['check', '--config', join(root, 'empty'), '--expect', B]);
assert.equal(r.status, 1, 'no installed_plugins.json fails'); assert.match(r.out, /no "sflow" marketplace|is missing/);
r = run(['check', '--config', config('nocache', { cache: false }).c, '--expect', B]);
assert.equal(r.status, 1, 'a missing cache dir fails'); assert.match(r.out, /cache dir .* is missing/);
r = run(['check', '--config', config('ref', { source: { source: 'github', repo: 'siddhant-angore/sflow', ref: 'feat/x' } }).c, '--expect', B]);
assert.equal(r.status, 1, 'a marketplace pinned to a branch fails'); assert.match(r.out, /pins ref "feat\/x"; that would install a branch/);
r = run(['check', '--config', config('local', { source: { source: 'directory', path: '/workspace/sflow' } }).c, '--expect', B]);
assert.equal(r.status, 1, 'a local marketplace fails'); assert.match(r.out, /only a GitHub source installs merged main/);
r = run(['check', '--config', join(root, 'ok'), '--expect', 'abc']); assert.equal(r.status, 1, 'a short --expect is refused'); assert.match(r.out, /full 40-character commit sha/);
r = run(['check', '--config', join(root, 'ok'), '--remote', `file://${join(root, 'nope.git')}`]); assert.equal(r.status, 1, 'an unreadable remote fails'); assert.match(r.out, /could not read main from file:/);
const nofile = config('nofile'); sh(root, `rm ${join(nofile.c, 'plugins', 'installed_plugins.json')}`);
r = run(['check', '--config', nofile.c, '--expect', B]); assert.equal(r.status, 1, 'a config with no installed_plugins.json fails'); assert.match(r.out, /installed_plugins\.json is missing/);
assert.equal(run(['check', '--expect', B], { CLAUDE_CONFIG_DIR: join(root, 'ok'), HOME: join(root, 'empty') }).status, 0, 'CLAUDE_CONFIG_DIR is read before ~/.claude');
assert.equal(run(['bogus']).status, 1, 'unknown command fails');
writeFileSync(join(root, 'ok', 'plugins', 'installed_plugins.json.bad'), '');
assert.equal(run(['check', '--config', join(root, 'ok'), '--expect', B], { CLAUDE_CONFIG_DIR: join(root, 'stale') }).status, 0, '--config wins over CLAUDE_CONFIG_DIR');
assert.equal(run(['check', '--expect', B], { CLAUDE_CONFIG_DIR: join(root, 'stale') }).status, 1, 'CLAUDE_CONFIG_DIR is the default config');

// refresh, with a stub claude that logs its calls and "installs" from the marketplace clone's HEAD
const bin = join(root, 'bin'); mkdirSync(bin);
const log = join(root, 'claude.log');
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const a = process.argv.slice(2), c0 = process.env.CLAUDE_CONFIG_DIR, c = c0 || path.join(process.env.HOME, '.claude');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a, c: c0 || null }) + '\\n');
if (process.env.STUB_FAIL && a.join(' ').startsWith(process.env.STUB_FAIL)) { console.error('stub failure'); process.exit(3); }
const p = path.join(c, 'plugins'), km = JSON.parse(fs.readFileSync(path.join(p, 'known_marketplaces.json')));
const loc = km.sflow.installLocation, ip = path.join(p, 'installed_plugins.json'), data = JSON.parse(fs.readFileSync(ip));
if (a[1] === 'marketplace' && a[2] === 'update' && !process.env.STUB_NO_MOVE) execFileSync('git', ['-C', loc, 'checkout', '-q', 'origin/main']);
if (a[1] === 'uninstall') delete data.plugins[a[2]];
if (a[1] === 'install') { const sha = process.env.STUB_SHA || execFileSync('git', ['-C', loc, 'rev-parse', 'HEAD']).toString().trim(); const d = path.join(p, 'cache', 'sflow', a[2].split('@')[0], 'new'); fs.mkdirSync(d, { recursive: true }); data.plugins[a[2]] = [{ scope: 'user', installPath: d, version: '0.5.0', gitCommitSha: sha }]; }
fs.writeFileSync(ip, JSON.stringify(data));
`);
chmodSync(join(bin, 'claude'), 0o755);
const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reset = () => writeFileSync(log, '');
const env = { SFLOW_CLAUDE_BIN: join(bin, 'claude') };

reset();
const s1 = config('r-stale', { sha: A, cloneAt: A });
r = run(['refresh', '--config', s1.c, '--remote', remote], env);
assert.equal(r.status, 0, `refresh brings a stale config to main: ${r.out}`);
assert.deepEqual(calls().map((x) => x.a.join(' ')), ['plugin marketplace update sflow', 'plugin uninstall sflow@sflow --keep-data', 'plugin install sflow@sflow', 'plugin uninstall sflow-flutter@sflow --keep-data', 'plugin install sflow-flutter@sflow'], 'marketplace update, then uninstall --keep-data and install per plugin');
assert.ok(calls().every((x) => x.c === s1.c), 'each call runs with CLAUDE_CONFIG_DIR set to its config');
assert.equal(run(['check', '--config', s1.c, '--remote', remote]).status, 0, 'check passes after the refresh');
assert.ok(JSON.parse(readFileSync(join(s1.c, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['other@else'], 'other marketplaces untouched');

reset();
r = run(['refresh', '--config', config('r-wrong', { sha: A, cloneAt: A }).c, '--remote', remote], { ...env, STUB_SHA: F });
assert.equal(r.status, 1, 'refresh ends with the check: an install that lands on another commit fails'); assert.match(r.out, new RegExp(`installed from ${F}, not main`));

reset();
r = run(['refresh', '--config', config('r-nomove', { sha: A, cloneAt: A }).c, '--remote', remote], { ...env, STUB_NO_MOVE: '1' });
assert.equal(r.status, 1, 'a marketplace clone that is not at main after the update fails'); assert.match(r.out, /nothing reinstalled/);
assert.deepEqual(calls().map((x) => x.a[1]), ['marketplace'], 'nothing is uninstalled when the clone is not at main');

reset();
r = run(['refresh', '--config', config('r-ref', { source: { source: 'github', repo: 'siddhant-angore/sflow', ref: 'feat/x' } }).c, '--expect', B], env);
assert.equal(r.status, 1, 'refresh refuses a branch-pinned marketplace'); assert.equal(calls().length, 0, 'and runs no claude command');
reset();
r = run(['refresh', '--config', config('r-local', { source: { source: 'directory', path: root } }).c, '--expect', B], env);
assert.equal(r.status, 1, 'refresh refuses a local marketplace'); assert.equal(calls().length, 0, 'and runs no claude command');

reset();
r = run(['refresh', '--config', config('r-fail', { sha: A, cloneAt: A }).c, '--remote', remote], { ...env, STUB_FAIL: 'plugin install sflow@sflow' });
assert.equal(r.status, 1, 'a failed install fails'); assert.match(r.out, /sflow@sflow is now UNINSTALLED in .*r-fail; rerun: CLAUDE_CONFIG_DIR=.* claude plugin install sflow@sflow/, 'and says how to recover');

reset();
r = run(['refresh', '--config', config('r-none', { plugins: [] }).c, '--remote', remote], env);
assert.equal(r.status, 1, 'nothing installed to refresh fails'); assert.ok(!calls().some((x) => x.a[1] === 'install'), 'and installs nothing');

reset();
const home = join(root, 'home'); mkdirSync(home);
const dflt = config('home/.claude', { sha: A, cloneAt: A });
r = run(['refresh', '--remote', remote], { ...env, HOME: home, CLAUDE_CONFIG_DIR: '' });
assert.equal(r.status, 0, `the default config (~/.claude) refreshes: ${r.out}`);
assert.ok(calls().every((x) => x.c === null), 'the default config runs claude without CLAUDE_CONFIG_DIR (so ~/.claude.json stays the global config)');
assert.ok(dflt.c.endsWith('/home/.claude'));

const text = readFileSync(script, 'utf8');
assert.doesNotMatch(text, /writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|permissions\.allow\s*[:=]/, 'the script itself writes nothing (only claude plugin commands change the install)');
console.log('refresh-install ok');
