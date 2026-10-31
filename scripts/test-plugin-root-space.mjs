#!/usr/bin/env node
// SID-49: every hook command of both plugins must find its script when CLAUDE_PLUGIN_ROOT contains a space.
// Claude Code substitutes the placeholder textually and runs the command through a shell, so an unquoted ${CLAUDE_PLUGIN_ROOT} splits at the space.
// Each plugin's hooks/ is copied into a temp dir whose path has a space and each command runs via `bash -c` with a minimal payload on stdin.
// The scripts may fail for their own reasons (no flutter, no git repo); the test only asserts they were found, so nothing here needs flutter, dart, very_good or a network.
//   node scripts/test-plugin-root-space.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = [['sflow', '.'], ['sflow-flutter', 'domains/flutter']];
const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' }, cwd: '/' });

export const commands = (hooksJson) => Object.values(hooksJson.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => h.type === 'command').map((h) => h.command)));

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
    }
    // Self-check: the old unquoted form must be caught, or this test proves nothing.
    const bad = missingScript('bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/analyze.sh', join(tmp, 'sflow-flutter'), tmp);
    assert.ok(bad.missing, `the unquoted form was not detected: exit ${bad.status}: ${bad.text}`);
    console.log('ok self-check: the unquoted form is detected');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
