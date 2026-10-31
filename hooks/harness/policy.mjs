// PreToolUse(Edit|Write|MultiEdit): the policy files are not the agent's to change. The shell route is closed in guard-rules.mjs (policyWriteReason).
import { deny, isPolicyPath, policyDeny, readEvent } from './lib.mjs';
const ev = readEvent();
const p = String(ev.tool_input?.file_path ?? '');
if (isPolicyPath(p)) deny(`harness: ${policyDeny(p.replace(/\\/g, '/'))}`);
