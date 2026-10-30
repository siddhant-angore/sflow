#!/usr/bin/env node
// Reports skill pairs whose descriptions are near-duplicates (stemmed TF-IDF cosine).
// Collisions are allowed: the playbooks name skills, so the model's description-based routing is not load-bearing. Exit 1 only with --strict.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = dirname(new URL(import.meta.url).pathname) + '/..';
const THRESHOLD = Number(process.env.ROUTING_THRESHOLD ?? 0.6);
const strict = process.argv.includes('--strict');
const stem = (w) => w.replace(/(ing|ed|es|s|ly|tion)$/, '');
const tokens = (s) => s.toLowerCase().match(/[a-z]{3,}/g)?.map(stem) ?? [];

const skills = [];
{
  const dir = join(root, 'skills');
  for (const name of readdirSync(dir)) {
    const f = join(dir, name, 'SKILL.md');
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const desc = /^description:\s*(.+)$/m.exec(text)?.[1] ?? '';
    if (!/^disable-model-invocation:\s*true/m.test(text)) skills.push({ id: name, toks: tokens(desc) });
  }
}
const df = new Map();
for (const s of skills) for (const t of new Set(s.toks)) df.set(t, (df.get(t) ?? 0) + 1);
const vec = (toks) => {
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v = new Map([...tf].map(([t, c]) => [t, (c / toks.length) * Math.log(skills.length / df.get(t))]));
  const norm = Math.sqrt([...v.values()].reduce((a, b) => a + b * b, 0)) || 1;
  return { v, norm };
};
const V = skills.map((s) => vec(s.toks));
const pairs = [];
for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
  let dot = 0;
  for (const [t, w] of V[i].v) dot += w * (V[j].v.get(t) ?? 0);
  const sim = dot / (V[i].norm * V[j].norm);
  if (sim >= THRESHOLD) pairs.push([sim, skills[i].id, skills[j].id]);
}
pairs.sort((a, b) => b[0] - a[0]);
console.log(`${skills.length} model-invocable skills; ${pairs.length} pairs at or above ${THRESHOLD}`);
for (const [s, a, b] of pairs) console.log(`${s.toFixed(2)}  ${a}  ~  ${b}`);
if (strict && pairs.length) process.exit(1);
