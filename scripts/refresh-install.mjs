#!/usr/bin/env node
// Refresh the installed sflow plugins to merged main, and check that they are on it (SID-144). Run after every merge to main.
// <config> is each --config <dir>, else $CLAUDE_CONFIG_DIR, else ~/.claude. Main is `git ls-remote <remote> refs/heads/main`, where <remote> is
// --remote <url>, else https://github.com/<repo>.git for the marketplace's GitHub source (then `gh api` if git has no credentials for a private
// repo); --expect <sha> skips the network.
//   check   [--config <dir>]... [--expect <sha>] [--remote <url>]  exit 1 unless every *@sflow plugin in every config was installed from main's
//                                                                   head commit (installed_plugins.json gitCommitSha) and its cache dir exists
//   refresh [--config <dir>]... [--expect <sha>] [--remote <url>]  per config: refuse a marketplace that would install a branch or a local
//                                                                   tree, `claude plugin marketplace update sflow`, refuse unless its clone is
//                                                                   now at main, reinstall each installed *@sflow plugin (uninstall --keep-data,
//                                                                   then install; `claude plugin update` is a no-op at the same version), then check
// It only installs merged main. It never edits settings, permissions or hooks, and adds no permissions.allow rule.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKETPLACE = 'sflow';
const SHA = /^[0-9a-f]{40}$/;
const defaultConfig = (env) => resolve(join(env.HOME || homedir(), '.claude'));

export function parseArgs(args, env = process.env) {
  const o = { configs: [], expect: null, remote: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = () => { if (!args[i + 1]) throw new Error(`${a} needs a value`); return args[++i]; };
    if (a === '--config') o.configs.push(resolve(v()));
    else if (a === '--expect') { o.expect = v().toLowerCase(); if (!SHA.test(o.expect)) throw new Error('--expect needs a full 40-character commit sha'); }
    else if (a === '--remote') o.remote = v();
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.configs.length) o.configs.push(resolve(env.CLAUDE_CONFIG_DIR || defaultConfig(env)));
  o.configs = [...new Set(o.configs)];
  return o;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw new Error(`${p}: ${e.message}`); } };
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

// The marketplace entry: only a GitHub source on its default branch (no ref, or ref main) installs merged main.
export function marketplaceProblems(config) {
  const known = readJson(join(config, 'plugins', 'known_marketplaces.json'));
  const m = known?.[MARKETPLACE];
  if (!m) return { problems: [`${config}: no "${MARKETPLACE}" marketplace in plugins/known_marketplaces.json`] };
  const s = m.source ?? {}, problems = [];
  if (s.source !== 'github' || typeof s.repo !== 'string') problems.push(`${config}: the ${MARKETPLACE} marketplace source is ${JSON.stringify(s)}; only a GitHub source installs merged main (a local or git-url source can be any branch)`);
  const ref = s.ref ?? s.branch;
  if (ref !== undefined && ref !== 'main' && ref !== 'refs/heads/main') problems.push(`${config}: the ${MARKETPLACE} marketplace pins ref "${ref}"; that would install a branch, not main`);
  return { problems, repo: s.repo, clone: m.installLocation };
}

export function expectedMain(o, repo) {
  if (o.expect) return o.expect;
  const url = o.remote ?? (repo ? `https://github.com/${repo}.git` : null);
  if (!url) throw new Error('no remote to read main from (pass --remote <url> or --expect <sha>)');
  const r = spawnSync('git', ['ls-remote', url, 'refs/heads/main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  let sha = r.status === 0 ? r.stdout.split(/\s/)[0] : '';
  // A private repo with no git credentials: ask gh, if it is signed in (read-only).
  if (!SHA.test(sha) && !o.remote && repo) { const g = spawnSync('gh', ['api', `repos/${repo}/commits/main`, '--jq', '.sha'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); if (g.status === 0) sha = g.stdout.trim(); }
  if (!SHA.test(sha)) throw new Error(`could not read main from ${url}: ${(r.stderr || 'no refs/heads/main').trim().split('\n')[0]}`);
  return sha;
}

// One line per installed *@sflow plugin entry, and the problems.
export function inspect(config, expected) {
  const lines = [], problems = [];
  const file = join(config, 'plugins', 'installed_plugins.json');
  const data = readJson(file);
  if (!data) return { lines, problems: [`${config}: ${file} is missing; no plugins installed there`] };
  const keys = Object.keys(data.plugins ?? {}).filter((k) => k.endsWith(`@${MARKETPLACE}`));
  if (!keys.length) problems.push(`${config}: no *@${MARKETPLACE} plugin installed`);
  for (const k of keys) for (const e of [].concat(data.plugins[k])) {
    const sha = String(e?.gitCommitSha ?? '');
    const ok = sha === expected && e?.installPath && existsSync(e.installPath);
    lines.push(`${ok ? 'ok      ' : 'MISMATCH'} ${k} ${e?.version ?? '?'} ${sha.slice(0, 12) || '(no sha)'} ${config}`);
    if (sha !== expected) problems.push(`${config}: ${k} is installed from ${sha || 'an unknown commit'}, not main ${expected}`);
    else if (!e?.installPath || !existsSync(e.installPath)) problems.push(`${config}: ${k} cache dir ${e?.installPath ?? '(none)'} is missing`);
  }
  return { lines, problems, plugins: keys };
}

export function check(o, log = console.log) {
  const all = [];
  for (const config of o.configs) {
    const mp = marketplaceProblems(config);
    const expected = expectedMain(o, mp.repo);
    const r = inspect(config, expected);
    r.lines.forEach((l) => log(l));
    all.push(...mp.problems, ...r.problems);
  }
  return all;
}

export function refresh(o, { log = console.log, env = process.env } = {}) {
  const bin = env.SFLOW_CLAUDE_BIN || 'claude';
  const problems = [];
  for (const config of o.configs) {
    const mp = marketplaceProblems(config);
    if (mp.problems.length) { problems.push(...mp.problems); continue; } // refuse before running anything
    const expected = expectedMain(o, mp.repo);
    const cenv = { ...env };
    if (config !== defaultConfig(env)) cenv.CLAUDE_CONFIG_DIR = config; else delete cenv.CLAUDE_CONFIG_DIR;
    const claude = (...a) => {
      log(`$ ${config === defaultConfig(env) ? '' : `CLAUDE_CONFIG_DIR=${config} `}claude ${a.join(' ')}`);
      const r = spawnSync(bin, a, { env: cenv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
      if (r.status !== 0) throw new Error(`claude ${a.join(' ')} failed (${r.status ?? r.error?.code}): ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    };
    try {
      claude('plugin', 'marketplace', 'update', MARKETPLACE);
      const head = mp.clone ? git(['rev-parse', 'HEAD'], mp.clone) : null;
      const at = head?.status === 0 ? head.stdout.trim() : '';
      if (at !== expected) { problems.push(`${config}: after the update the ${MARKETPLACE} marketplace clone is at ${at || 'an unreadable commit'}, not main ${expected}; nothing reinstalled`); continue; }
      const { plugins = [] } = inspect(config, expected);
      if (!plugins.length) { problems.push(`${config}: no *@${MARKETPLACE} plugin installed to refresh (install it once by hand)`); continue; }
      for (const p of plugins) {
        claude('plugin', 'uninstall', p, '--keep-data');
        try { claude('plugin', 'install', p); }
        catch (e) { throw new Error(`${e.message}. ${p} is now UNINSTALLED in ${config}; rerun: ${config === defaultConfig(env) ? '' : `CLAUDE_CONFIG_DIR=${config} `}claude plugin install ${p}`); }
      }
    } catch (e) { problems.push(`${config}: ${e.message}`); continue; }
  }
  return [...problems, ...check(o, log)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd !== 'check' && cmd !== 'refresh') throw new Error('usage: refresh-install.mjs check|refresh [--config <dir>]... [--expect <sha>] [--remote <url>]');
    const o = parseArgs(rest);
    const problems = cmd === 'check' ? check(o) : refresh(o);
    if (problems.length) { console.error(`\nFAIL: the installed sflow is not merged main:\n${problems.map((p) => `  - ${p}`).join('\n')}`); process.exit(1); }
    console.log(`\nok: every *@${MARKETPLACE} plugin in ${o.configs.length} config(s) is installed from main`);
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
