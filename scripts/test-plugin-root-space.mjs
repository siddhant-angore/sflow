#!/usr/bin/env node
// SID-49: every hook command of both plugins must find its script when CLAUDE_PLUGIN_ROOT contains a space.
// That covers hooks/hooks.json and the `hooks:` block in the YAML frontmatter of every agent (agents/*.md) and skill (skills/*/SKILL.md).
// Claude Code substitutes the placeholder textually and runs the command through a shell, so an unquoted ${CLAUDE_PLUGIN_ROOT} splits at the space.
// Each plugin's hooks/ is copied into a temp dir whose path has a space and each command runs via `bash -c` with a minimal payload on stdin.
// The scripts may fail for their own reasons (no flutter, no git repo); the test only asserts they were found, so nothing here needs flutter, dart, very_good or a network.
//   node scripts/test-plugin-root-space.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = [['sflow', '.'], ['sflow-flutter', 'domains/flutter']];
const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' }, cwd: '/' });

export const commands = (hooksJson) => Object.values(hooksJson.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => h.type === 'command').map((h) => h.command)));

// Hook commands in a Markdown file's YAML frontmatter: every `command:` value inside its top-level `hooks:` block.
// YAML double-quoted strings use the JSON escapes these files need (\" and \\); single-quoted ones double a quote ('').
export function frontmatterCommands(text) {
  const fm = text.replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---(\n|$)/)?.[1];
  if (!fm) return [];
  const out = [];
  let inHooks = false;
  for (const line of fm.split('\n')) {
    if (/^\S/.test(line)) inHooks = /^hooks:\s*$/.test(line);
    const m = inHooks && line.match(/^\s+(?:-\s+)?command:\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[1];
    out.push(v.startsWith('"') ? JSON.parse(v) : v.startsWith("'") ? v.slice(1, -1).replaceAll("''", "'") : v);
  }
  return out;
}

// Every agent and skill file of a plugin dir that declares frontmatter hooks, as [relative path, command].
export function agentAndSkillCommands(pluginDir) {
  const files = [];
  const agents = join(pluginDir, 'agents'), skills = join(pluginDir, 'skills');
  if (existsSync(agents)) for (const f of readdirSync(agents)) if (f.endsWith('.md')) files.push(join('agents', f));
  if (existsSync(skills)) for (const d of readdirSync(skills)) if (existsSync(join(skills, d, 'SKILL.md'))) files.push(join('skills', d, 'SKILL.md'));
  return files.flatMap((rel) => frontmatterCommands(readFileSync(join(pluginDir, rel), 'utf8')).map((cmd) => [rel, cmd]));
}

// The failure signature of an unquoted placeholder: bash is handed a path cut at the space, or the interpreter cannot open the script.
export function missingScript(cmd, pluginRoot, cwd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, input: PAYLOAD, encoding: 'utf8', timeout: 20000, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: cwd } });
  const text = (r.stderr ?? '') + (r.stdout ?? '');
  return { status: r.status, text, missing: r.status === 127 || /No such file or directory|Cannot find module|can't open file/.test(text) };
}

function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'sflow plugin root '));
  try {
    for (const [name, dir] of PLUGINS) {
      const pluginRoot = join(tmp, name);
      cpSync(join(repo, dir, 'hooks'), join(pluginRoot, 'hooks'), { recursive: true });
      const cmds = commands(JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')));
      assert.ok(cmds.length > 0, `${name}: no hook commands found`);
      for (const cmd of cmds) {
        const r = missingScript(cmd, pluginRoot, tmp);
        assert.ok(!r.missing, `${name}: cannot find its script under a root with a space\n  command: ${cmd}\n  exit ${r.status}: ${r.text.slice(0, 300)}`);
        console.log(`ok ${name}: ${cmd} (exit ${r.status})`);
      }
      // Agent and skill frontmatter hooks run with the same CLAUDE_PLUGIN_ROOT, so they get the same test.
      const fmCmds = agentAndSkillCommands(join(repo, dir));
      for (const [rel, cmd] of fmCmds) {
        assert.match(cmd, /\$\{?CLAUDE_PLUGIN_ROOT/, `${name}: ${rel}: a frontmatter hook that does not use the plugin root needs its own check\n  command: ${cmd}`);
        const r = missingScript(cmd, pluginRoot, tmp);
        assert.ok(!r.missing, `${name}: ${rel}: frontmatter hook cannot find its script under a root with a space\n  command: ${cmd}\n  exit ${r.status}: ${r.text.slice(0, 300)}`);
        console.log(`ok ${name}: ${rel}: ${cmd} (exit ${r.status})`);
      }
      if (name === 'sflow-flutter') assert.ok(fmCmds.some(([rel]) => rel === 'agents/flutter-reviewer.md'), 'the frontmatter scan found no hook in agents/flutter-reviewer.md, so it proves nothing');
    }
    // Self-check: the old unquoted form must be caught, or this test proves nothing.
    const bad = missingScript('bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/analyze.sh', join(tmp, 'sflow-flutter'), tmp);
    assert.ok(bad.missing, `the unquoted form was not detected: exit ${bad.status}: ${bad.text}`);
    console.log('ok self-check: the unquoted form is detected');
    // The same for frontmatter: the unquoted flutter-reviewer form must be caught, and the parser must read both YAML quote styles.
    const fmBad = frontmatterCommands('---\nname: x\nhooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/allow-readonly-git.sh"\n---\n');
    assert.deepEqual(fmBad, ['bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/allow-readonly-git.sh']);
    assert.ok(missingScript(fmBad[0], join(tmp, 'sflow-flutter'), tmp).missing, 'the unquoted frontmatter form was not detected');
    assert.deepEqual(frontmatterCommands('---\nhooks:\n  Stop:\n    - hooks:\n        - command: \'bash "${CLAUDE_PLUGIN_ROOT}/x.sh"\'\n          type: command\ncommand: "not a hook"\n---\nbody\ncommand: no\n'), ['bash "${CLAUDE_PLUGIN_ROOT}/x.sh"']);
    console.log('ok self-check: the unquoted frontmatter form is detected');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
