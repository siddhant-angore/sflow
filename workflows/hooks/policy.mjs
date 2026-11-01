// PreToolUse(Edit|Write|MultiEdit|NotebookEdit): the policy files are not the agent's to change. The shell route is closed in guard-rules.mjs (policyWriteReason).
// Nor are git hook and config files (SID-162): the shell guard denies writes into hooks dirs and git config, and the file tools get the same rule (hookFileReason).
// Fails closed: an unreadable event, a git error (missing binary, safe.directory refusal, broken config) or any exception denies the write.
const failClosed = (e) => {
  const why = `harness hook error (failing closed): ${String(e?.message ?? e).split('\n')[0]}; the file write is blocked`;
  try { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }) + '\n'); } catch {}
  process.stderr.write(why + '\n');
  process.exit(2);
};
process.on('uncaughtException', failClosed);
try {
  const { readFileSync } = await import('node:fs');
  const { deny, hookFileReason, isPolicyPath, policyDeny } = await import('./lib.mjs');
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch (e) { throw new Error(`unreadable hook event (${e.message})`); }
  if (!ev || typeof ev !== 'object') throw new Error('unreadable hook event');
  const p = String(ev.tool_input?.file_path ?? ev.tool_input?.notebook_path ?? '');
  if (isPolicyPath(p)) deny(`harness: ${policyDeny(p.replace(/\\/g, '/'))}`);
  else { const why = hookFileReason(p, ev.cwd || process.cwd()); if (why) deny(`harness: ${why}`); }
} catch (e) { failClosed(e); }
