#!/usr/bin/env node
// The release version lives in four fields (core plugin.json, both marketplace.json entries, flutter plugin.json). Exit 1 unless they agree.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function versionProblems(root) {
  const problems = [], fields = {};
  const load = (rel) => {
    if (!existsSync(join(root, rel))) { problems.push(`missing file: ${rel}`); return null; }
    try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch (e) { problems.push(`unreadable ${rel}: ${e.message}`); return null; }
  };
  const take = (label, v) => (typeof v === 'string' && v ? (fields[label] = v) : problems.push(`missing field: ${label}`));
  const core = load('.claude-plugin/plugin.json');
  if (core) take('.claude-plugin/plugin.json version', core.version);
  const market = load('.claude-plugin/marketplace.json');
  if (market) for (const name of ['sflow', 'sflow-flutter']) {
    const entry = (market.plugins ?? []).find((p) => p.name === name);
    if (!entry) problems.push(`missing marketplace entry: ${name}`);
    else take(`.claude-plugin/marketplace.json plugins[${name}].version`, entry.version);
  }
  const flutter = load('domains/flutter/.claude-plugin/plugin.json');
  if (flutter) take('domains/flutter/.claude-plugin/plugin.json version', flutter.version);
  if (new Set(Object.values(fields)).size > 1) problems.push(`version disagreement: ${Object.entries(fields).map(([k, v]) => `${k} = ${v}`).join('; ')}`);
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = versionProblems(root);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`versions ok: ${JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version} (4 fields agree)`);
}
