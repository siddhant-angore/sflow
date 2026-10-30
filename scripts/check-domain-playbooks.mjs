#!/usr/bin/env node
// Domain packs (domains/<name>/playbooks/*.md) are overlays in pstack's project-playbook format, read by the agent at run time
// beside the core playbook. This checks every anchor still exists in the core playbook after a sync. Exit 1 on a stale one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = join(dirname(new URL(import.meta.url).pathname), '..');
const core = join(root, 'skills', 'poteto-mode', 'playbooks');
const CHANGE = /^\s*(?:[-*]|\d+\.)\s+\*\*(After|Before|Replace|In)\*\*\s+"([^"]+)":/;
const CHANGE_VERB = /^\s*(?:[-*]|\d+\.)\s+\*\*(?:After|Before|Replace|In)\*\*/;
const flat = (t) => t.replace(/\s+/g, ' ');
const problems = []; let count = 0;
const domains = existsSync(join(root, 'domains')) ? readdirSync(join(root, 'domains')) : [];
for (const d of domains) {
  const dir = join(root, 'domains', d, 'playbooks');
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    count++;
    const path = `domains/${d}/playbooks/${f}`;
    const text = readFileSync(join(dir, f), 'utf8');
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
    const field = (k) => front.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'))?.[1].trim() ?? '';
    if (!field('when')) problems.push(`${path}: needs a when: line`);
    const ext = field('extends');
    const base = ext && join(core, `${ext}.md`);
    if (ext && !existsSync(base)) { problems.push(`${path}: extends ${ext}, which the core has no playbook for`); continue; }
    const baseText = ext ? flat(readFileSync(base, 'utf8')) : '';
    for (const line of text.split('\n')) {
      if (CHANGE_VERB.test(line) && !CHANGE.test(line)) problems.push(`${path}: a change has no straight-quoted anchor: ${line.trim().slice(0, 70)}`);
      const a = CHANGE.exec(line)?.[2];
      if (a && !baseText.includes(flat(a))) problems.push(`${path}: "${a}" is not in ${ext}.md`);
    }
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`domain playbooks ok: ${count} overlays in ${domains.length} domain(s)`);
