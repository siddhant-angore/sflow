// Offline tests for eval-brake's failure handling: stubbed exec, no claude, no network, no cost. Run: node scripts/test-eval-brake.mjs
import assert from 'node:assert/strict';
import { classifyFailure, formatCliFailure, parseArgs, runClaude, summarize } from './eval-brake.mjs';

const execErr = (o) => Object.assign(new Error('Command failed: claude -p --model haiku'), o);
const good = JSON.stringify({ subtype: 'success', is_error: false, result: 'gate blocked it', total_cost_usd: 0.0099, num_turns: 11 });
const observed = JSON.stringify({ duration_api_ms: 0, is_error: true, subtype: 'error_during_execution', stop_reason: 'stop_sequence', session_id: 's-1', num_turns: 0, total_cost_usd: 0 });
const maxTurns = JSON.stringify({ duration_api_ms: 900, is_error: true, subtype: 'error_max_turns', num_turns: 12, total_cost_usd: 0.02 });

// exec stub: each call consumes the next scripted item; an Error is thrown, anything else is returned as stdout.
const harness = (script, over = {}) => {
  const c = { exec: 0, setup: 0, sleep: 0, logs: [] };
  const opts = {
    exec: () => { const x = script[c.exec++]; if (x === undefined) throw new Error('unexpected extra exec call'); if (x instanceof Error) throw x; return Buffer.from(x); },
    setup: () => `/tmp/fake-repo-${++c.setup}`,
    verify: () => {},
    sleep: async () => { c.sleep++; },
    log: (m) => c.logs.push(m),
    ...over,
  };
  return { c, go: () => runClaude(opts) };
};

// 1. The observed failure: readable, no Buffer dump, shows exit code, subtype, stderr tail.
{
  const err = execErr({ status: 1, signal: null, stdout: Buffer.from(observed), stderr: Buffer.from('warn\nAPI Error: boom\n') });
  const msg = formatCliFailure(err);
  assert.doesNotMatch(msg, /<Buffer/);
  assert.doesNotMatch(msg, /\d+, \d+, \d+, \d+/);
  for (const s of ['exit 1', 'subtype=error_during_execution', 'is_error=true', 'duration_api_ms=0', 'num_turns=0', 'stderr (tail)', 'API Error: boom']) assert.ok(msg.includes(s), `missing ${s} in:\n${msg}`);
  assert.equal(classifyFailure(err).transient, true, 'is_error with duration_api_ms 0 is transient');
}

// 2. Non-JSON stdout: only the tail is shown.
{
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const msg = formatCliFailure(execErr({ status: 3, stdout: Buffer.from(lines), stderr: Buffer.from('') }));
  assert.match(msg, /stdout \(tail, not JSON\)/);
  assert.ok(msg.includes('line 99') && !msg.includes('line 0\n') && !msg.includes('line 50'), msg);
  assert.doesNotMatch(msg, /<Buffer/);
}

// 3. ENOENT: permanent infra, one attempt, no sleep.
{
  const h = harness([execErr({ code: 'ENOENT', status: null, stdout: null, stderr: null })]);
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec, h.c.sleep], ['infra', 1, 0]);
  assert.equal(classifyFailure(execErr({ code: 'ENOENT' })).transient, false);
}

// 4. 429 / overloaded: retried once in a fresh repo, then passes.
for (const stderr of ['API Error: 429 rate limit exceeded', 'overloaded_error: Overloaded']) {
  const h = harness([execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from(stderr) }), good]);
  const r = await h.go();
  assert.deepEqual([r.status, r.attempts, h.c.exec, h.c.setup, h.c.sleep], ['pass', 2, 2, 2, 1], stderr);
}

// 4b. Spend from a failed attempt is counted: 0.002 transient failure + 0.009 pass = 0.011.
{
  const failed = JSON.stringify({ duration_api_ms: 0, is_error: true, subtype: 'error_during_execution', num_turns: 0, total_cost_usd: 0.002 });
  const passed = JSON.stringify({ subtype: 'success', is_error: false, result: 'gate blocked it', total_cost_usd: 0.009, num_turns: 5 });
  const h = harness([execErr({ status: 1, stdout: Buffer.from(failed), stderr: Buffer.from('overloaded_error') }), passed]);
  const r = await h.go();
  assert.equal(r.status, 'pass');
  assert.ok(Math.abs(r.cost - 0.011) < 1e-9, `cost ${r.cost}`);
}

// 4c. PERMANENT does not misfire on the eval's own text, and still catches real auth errors.
{
  const forbidden = classifyFailure(execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('lint: forbidden token in b.txt') }));
  assert.notEqual(forbidden.reason, 'auth or model error');
  assert.equal(classifyFailure(execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('author: e') })).reason, 'unrecognised failure');
  const auth = classifyFailure(execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Invalid API key · Please run /login') }));
  assert.deepEqual([auth.transient, auth.reason], [false, 'auth or model error']);
  assert.equal(classifyFailure(execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('HTTP 403 Forbidden') })).reason, 'auth or model error');
}

// 5. Timeout (ETIMEDOUT, SIGTERM) is transient too; twice in a row is infra after exactly 2 attempts.
{
  const to = () => execErr({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: Buffer.from(''), stderr: Buffer.from('') });
  const h = harness([to(), to(), good]);
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec, h.c.sleep], ['infra', 2, 1]);
  assert.ok(h.c.logs.some((l) => l.includes('attempt 1')) && h.c.logs.some((l) => l.includes('attempt 2')), 'each attempt is printed');
  assert.ok(h.c.logs.every((l) => !l.includes('<Buffer')));
}

// 6. Auth error: permanent, no retry.
{
  const h = harness([execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Invalid API key. Please run /login') }), good]);
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec, h.c.sleep], ['infra', 1, 0]);
}

// 7. error_max_turns: infra, no retry (also when claude exits 0 with an error result).
for (const e of [execErr({ status: 1, stdout: Buffer.from(maxTurns), stderr: Buffer.from('') }), maxTurns]) {
  const h = harness([e, good]);
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec, h.c.sleep], ['infra', 1, 0]);
  assert.ok(h.c.logs.join('\n').includes('error_max_turns'));
}

// 8. Exit 0 with unparseable output: infra, no retry.
{
  const h = harness(['not json at all', good]);
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec], ['infra', 1]);
}

// 9. A real assertion failure is a brake verdict, readable, never retried.
{
  const h = harness([good, good], { verify: () => assert.equal('abc', '', 'the branch must not reach origin') });
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec, h.c.sleep], ['brake', 1, 0]);
  assert.ok(h.c.logs.join('\n').includes('brake FAILED: the branch must not reach origin'));
}

// 10. Summary: pass rate line, cost sum, exit code precedence (brake fail beats infra).
{
  const p = (cost) => ({ status: 'pass', cost });
  const s = summarize([p(0.0099), p(0.0089)], 'haiku');
  assert.equal(s.code, 0);
  assert.equal(s.text, 'eval-brake: 2/2 runs passed (model haiku, total cost $0.0188)');
  assert.equal(summarize([p(0.01), { status: 'infra', cost: 0 }], 'haiku').code, 2);
  assert.equal(summarize([{ status: 'infra', cost: 0 }, { status: 'brake', cost: 0.01 }], 'haiku').code, 1);
  assert.match(summarize([{ status: 'infra', cost: 0 }], 'haiku').text, /harness\/CLI error, not a brake verdict; rerun/);
}

// 11. Args: default, cap at 5, rejects junk.
{
  assert.deepEqual(parseArgs([]), { model: 'haiku', runs: 1 });
  assert.deepEqual(parseArgs(['--runs', '9', '--model', 'sonnet']), { model: 'sonnet', runs: 5 });
  assert.throws(() => parseArgs(['--runs', 'x']), /--runs/);
}

console.log('test-eval-brake ok (formatting, classification, bounded retry, exit-code precedence)');
