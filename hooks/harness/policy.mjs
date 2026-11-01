// PreToolUse(Edit|Write|MultiEdit): the policy files are not the agent's to change. The shell route is closed in guard-rules.mjs (policyWriteReason).
// Nor are git hook files (SID-162): the shell guard denies writes into hooks dirs, and the file tools get the same rule (hookFileReason).
import { deny, hookFileReason, isPolicyPath, policyDeny, readEvent } from './lib.mjs';
const ev = readEvent();
const p = String(ev.tool_input?.file_path ?? '');
if (isPolicyPath(p)) deny(`harness: ${policyDeny(p.replace(/\\/g, '/'))}`);
else { const why = hookFileReason(p, ev.cwd || process.cwd()); if (why) deny(`harness: ${why}`); }
