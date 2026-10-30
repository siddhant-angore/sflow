#!/usr/bin/env node
// Applies the overlays in workflows/ to the vendored poteto-mode playbooks, in place, so the agent reads one merged file per workflow.
// Overlay frontmatter: `extends: <playbook stem>` (or `target: <path from repo root>`), `when: <one sentence>`.
// A change line is `- **After|Before|Replace|In** "verbatim words from the target": text`. A stale anchor fails the build.
// An overlay with an empty `extends:` becomes a new playbook file and is listed in poteto-mode's Playbooks section.
// A directory workflows/<name>/SKILL.md is an sflow-authored skill, installed into skills/<name>/.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const playbooks = join(root, 'skills', 'poteto-mode', 'playbooks');
const skill = join(root, 'skills', 'poteto-mode', 'SKILL.md');
const CHANGE = /^\s*(?:[-*]|\d+\.)\s+\*\*(After|Before|Replace|In)\*\*\s+"([^"]+)":\s*(.*)$/;
const CHANGE_VERB = /^\s*(?:[-*]|\d+\.)\s+\*\*(?:After|Before|Replace|In)\*\*/;
const problems = [];
const newPlaybooks = [];

const anchorRegex = (anchor) => new RegExp(anchor.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));

for (const name of readdirSync(join(root, 'workflows')).filter((f) => f.endsWith('.md')).sort()) {
  const path = `workflows/${name}`;
  const text = readFileSync(join(root, 'workflows', name), 'utf8').replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) { problems.push(`${path}: no frontmatter`); continue; }
  const field = (k) => fm[1].match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'))?.[1].trim() ?? '';
  const when = field('when'), ext = field('extends'), target = field('target');
  if (!when) problems.push(`${path}: needs a when: line`);
  const stem = name.replace(/\.md$/, '');
  const body = fm[2].replace(/^#[^\n]*\n/m, '').trim() + '\n';

  if (!ext && !target) {
    const dest = join(playbooks, `${stem}.md`);
    if (existsSync(dest)) { problems.push(`${path}: ${stem}.md already exists upstream; set extends: instead`); continue; }
    writeFileSync(dest, body);
    newPlaybooks.push({ stem, when });
    continue;
  }
  const file = target ? join(root, target) : join(playbooks, `${ext}.md`);
  if (!existsSync(file)) { problems.push(`${path}: ${target || ext} is not a playbook this pstack has`); continue; }
  let out = readFileSync(file, 'utf8');
  for (const line of body.split('\n')) {
    if (!CHANGE_VERB.test(line)) continue;
    const m = CHANGE.exec(line);
    if (!m) { problems.push(`${path}: a change has no straight-quoted anchor: ${line.slice(0, 80)}`); continue; }
    const [, verb, anchor, change] = m;
    const hit = anchorRegex(anchor).exec(out);
    if (!hit) { problems.push(`${path}: "${anchor}" is not in ${target || ext + '.md'}`); continue; }
    const lineStart = out.lastIndexOf('\n', hit.index) + 1;
    const lineEnd = out.indexOf('\n', hit.index + hit[0].length);
    const indent = /^\s*/.exec(out.slice(lineStart))[0];
    const sub = `${indent}   - **sflow (${verb.toLowerCase()}):** ${change}\n`;
    if (verb === 'Replace') out = out.slice(0, hit.index) + change + out.slice(hit.index + hit[0].length);
    else if (verb === 'Before') out = out.slice(0, lineStart) + `${indent}- **sflow (before):** ${change}\n` + out.slice(lineStart);
    else out = out.slice(0, lineEnd + 1) + sub + out.slice(lineEnd + 1);
  }
  writeFileSync(file, out);
}

if (newPlaybooks.length) {
  const anchor = '- **Opening a PR.** Invoked at the end of every other playbook.';
  let s = readFileSync(skill, 'utf8');
  if (!s.includes(anchor)) problems.push(`skills/poteto-mode/SKILL.md: playbook list anchor not found`);
  else s = s.replace(anchor, anchor + '\n' + newPlaybooks.map((p) => `- **${p.stem[0].toUpperCase() + p.stem.slice(1)}.** ${p.when} File: \`playbooks/${p.stem}.md\`.`).join('\n'));
  writeFileSync(skill, s);
}
// Authored skills live beside the overlays (a vendored directory is wiped on every sync) and are installed here.
for (const d of readdirSync(join(root, 'workflows'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
  if (!existsSync(join(root, 'workflows', d.name, 'SKILL.md'))) continue;
  if (existsSync(join(root, 'skills', d.name))) { problems.push(`workflows/${d.name}: a vendored skill already has that name`); continue; }
  cpSync(join(root, 'workflows', d.name), join(root, 'skills', d.name), { recursive: true });
}
// Harness hooks: workflows/hooks/*.mjs are installed under hooks/harness/ and their events appended to the vendored hooks/hooks.json.
{
  const src = join(root, 'workflows', 'hooks');
  if (existsSync(src)) {
    const dest = join(root, 'hooks', 'harness');
    cpSync(src, dest, { recursive: true, filter: (f) => !f.endsWith('hooks.json') });
    const manifestPath = join(root, 'hooks', 'hooks.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { hooks: {} };
    const add = JSON.parse(readFileSync(join(src, 'hooks.json'), 'utf8'));
    manifest.hooks ??= {};
    for (const [event, entries] of Object.entries(add)) manifest.hooks[event] = [...(manifest.hooks[event] ?? []), ...entries];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

// Domain packs: domains/<d>/authored/<name>/SKILL.md is installed into domains/<d>/skills/<name>/ the same way.
const domainsDir = join(root, 'domains');
for (const d of existsSync(domainsDir) ? readdirSync(domainsDir) : []) {
  const authored = join(domainsDir, d, 'authored');
  if (!existsSync(authored)) continue;
  for (const name of readdirSync(authored)) {
    if (existsSync(join(domainsDir, d, 'skills', name))) { problems.push(`domains/${d}/authored/${name}: a vendored skill already has that name`); continue; }
    cpSync(join(authored, name), join(domainsDir, d, 'skills', name), { recursive: true });
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`workflows built: ${readdirSync(join(root, 'workflows')).filter((f) => f.endsWith('.md')).length} overlays, ${newPlaybooks.length} new playbooks`);
