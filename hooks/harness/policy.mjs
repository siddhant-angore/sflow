// PreToolUse(Edit|Write|MultiEdit): the policy files are not the agent's to change.
import { deny, readEvent } from './lib.mjs';
const ev = readEvent();
const p = String(ev.tool_input?.file_path ?? '').replace(/\\/g, '/');
const POLICY = ['/.harness.json', '/.claude/settings.json', '/.claude/settings.local.json'];
if (POLICY.some((suffix) => p.endsWith(suffix))) deny(`harness: ${p} is policy; a human changes it on the protected branch`);
