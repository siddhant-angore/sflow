// SessionStart: point the agent at the sflow router for work that needs one, and say how pstack skills are read.
// Fail-open: any error exits 0 with no output, so a broken hook never blocks a session.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ignoredNote, readEvent } from './lib.mjs';

const ev = readEvent();
const hasDotGit = (dir) => { for (let d = resolve(dir); ; d = dirname(d)) { if (existsSync(join(d, '.git'))) return true; if (dirname(d) === d) return false; } };
try {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const lines = [
    'You have sflow.',
    '',
    'Invoke the `sflow:sflow` skill and follow it when a task meets any of these:',
    '',
    '- it touches more than one file',
    '- it involves a design or architecture choice',
    '- it is a bug whose cause is not yet known, or a performance issue',
    '',
    'It routes to the right playbook from there. For a contained change to one file, a question, or a one-line edit, work directly and verify on the real artifact.',
    '',
    `The Skill tool refuses the pstack skills (tdd, how, why, arena, poteto-mode, and the principles). Read them with the Read tool instead: \`${join(pluginRoot, 'skills', '<name>', 'SKILL.md')}\`. docs/harness/claude-code.md in the same plugin explains the mapping.`,
    '',
    'User instructions (CLAUDE.md, AGENTS.md, direct requests) take precedence.',
  ];
  try { // own try: the notes are optional
    const cwd = ev.cwd ?? process.cwd();
    const cfg = config(cwd);
    if (cfg.ignoredLocal) lines.push('', ignoredNote(cfg));
    if (cfg.unreadable && hasDotGit(cwd)) lines.push('', 'git can not read this repository, so the guard is running with strict defaults (merges denied, main and master protected). Check its config: core.bare, core.repositoryformatversion, core.worktree, include.path.');
  } catch {}
  const context = lines.join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) + '\n');
} catch {
  process.exit(0);
}
