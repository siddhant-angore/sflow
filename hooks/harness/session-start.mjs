// SessionStart: point the agent at the sflow router for work that needs one, and say how pstack skills are read.
// Fail-open: any error exits 0 with no output, so a broken hook never blocks a session.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const context = [
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
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) + '\n');
} catch {
  process.exit(0);
}
