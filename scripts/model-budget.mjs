#!/usr/bin/env node
// Install or check the sflow default model budget (templates/pstack-models.md) in Claude Code configs (SID-143).
// The sheet goes to <config>/rules/pstack-models.md, which Claude Code loads into every session (docs/harness/claude-code.md, Models).
// <config> is each --config <dir>, else $CLAUDE_CONFIG_DIR, else ~/.claude. It writes nothing outside <config>/rules/ and touches no settings or permissions.
//   install [--config <dir>]... [--force]  write the sheet where it is missing; a sheet that differs is kept unless --force
//   check   [--config <dir>]...            exit 1 unless every config has a valid sheet (known models and efforts only)
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = join(root, 'templates', 'pstack-models.md');
// The Agent tool's model and effort values on Claude Code (docs/harness/claude-code.md, Models).
export const MODELS = new Set(['opus', 'fable', 'sonnet', 'haiku']);
export const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ALIASES = new Set(['inherit-parent', 'auto']);

export const sheetPath = (config) => join(config, 'rules', 'pstack-models.md');

export function configsFrom(args, env = process.env) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--config') {
    if (!args[i + 1]) throw new Error('--config needs a directory');
    out.push(resolve(args[++i]));
  }
  if (!out.length) out.push(resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
  return [...new Set(out)];
}

// Parse a sheet into role -> [entry]. Returns { roles, problems }.
export function parseSheet(text) {
  const roles = new Map(), problems = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = line.lastIndexOf(':');
    if (at <= 0) { problems.push(`line ${i + 1}: not "role: model"`); return; }
    const role = line.slice(0, at).trim(), entries = line.slice(at + 1).split(',').map((s) => s.trim());
    if (role === 'default effort' || role === 'session hook') return; // runtime settings, not roles
    for (const e of entries) {
      const [model, effort, ...rest] = e.split(/\s+/);
      if (ALIASES.has(model) && effort === undefined) continue;
      if (!MODELS.has(model)) problems.push(`line ${i + 1}: unknown model "${model ?? ''}" for ${role}`);
      else if (effort !== undefined && !EFFORTS.has(effort)) problems.push(`line ${i + 1}: unknown effort "${effort}" for ${role}`);
      else if (rest.length) problems.push(`line ${i + 1}: unexpected "${rest.join(' ')}" for ${role}`);
    }
    roles.set(role, entries);
  });
  if (!roles.size) problems.push('no role lines');
  return { roles, problems };
}

export function install(configs, { force = false, log = console.log } = {}) {
  const template = readFileSync(TEMPLATE, 'utf8');
  for (const config of configs) {
    const path = sheetPath(config);
    if (existsSync(path)) {
      const current = readFileSync(path, 'utf8');
      if (current === template) { log(`current   ${path}`); continue; }
      if (!force) { log(`kept      ${path} (differs from the sflow default; --force replaces it)`); continue; }
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template);
    log(`installed ${path}`);
  }
}

export function check(configs, { log = console.log } = {}) {
  const template = readFileSync(TEMPLATE, 'utf8');
  let ok = true;
  for (const config of configs) {
    const path = sheetPath(config);
    if (!existsSync(path)) { ok = false; log(`MISSING   ${path} (run: npm run model-budget -- install --config ${config})`); continue; }
    const text = readFileSync(path, 'utf8');
    const { roles, problems } = parseSheet(text);
    if (problems.length) { ok = false; log(`INVALID   ${path}\n  ${problems.join('\n  ')}`); continue; }
    const workers = (roles.get('swarm workers') ?? ['(skill default)']).join(', ');
    log(`${text === template ? 'ok        ' : 'ok custom '}${path} (${roles.size} roles; swarm workers: ${workers})`);
  }
  return ok;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const usage = 'usage: model-budget.mjs install|check [--config <dir>]... [--force]';
  try {
    const known = new Set(['--config', '--force']);
    const bad = args.filter((a, i) => a.startsWith('-') && !known.has(a) && args[i - 1] !== '--config');
    if (bad.length) throw new Error(`unknown option ${bad[0]}`);
    const configs = configsFrom(args);
    if (cmd === 'install') { install(configs, { force: args.includes('--force') }); process.exit(check(configs) ? 0 : 1); }
    if (cmd === 'check') process.exit(check(configs) ? 0 : 1);
    console.error(usage); process.exit(2);
  } catch (e) { console.error(`${e.message}\n${usage}`); process.exit(2); }
}
