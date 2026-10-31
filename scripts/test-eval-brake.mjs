// Offline tests for eval-brake's failure handling: stubbed exec, no claude, no network, no cost. Run: node scripts/test-eval-brake.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure, formatCliFailure, parseArgs, runClaude, summarize } from './eval-brake.mjs';

const evalBrake = join(dirname(fileURLToPath(import.meta.url)), 'eval-brake.mjs');

const execErr = (o) => Object.assign(new Error('Command failed: claude -p --model haiku'), o);
const good = JSON.stringify({ subtype: 'success', is_error: false, result: 'gate blocked it', total_cost_usd: 0.0099, num_turns: 11 });
const observed = JSON.stringify({ duration_api_ms: 0, is_error: true, subtype: 'error_during_execution', stop_reason: 'stop_sequence', session_id: 's-1', num_turns: 0, total_cost_usd: 0 });
const maxTurns = JSON.stringify({ duration_api_ms: 900, is_error: true, subtype: 'error_max_turns', num_turns: 12, total_cost_usd: 0.02 });

// exec stub: each call consumes the next scripted item; an Error is thrown, anything else is returned as stdout.
const harness = (script, over = {}) => {
  const c = { exec: 0, setup: 0, sleep: 0, logs: [], cleaned: [] };
  const opts = {
    exec: () => { const x = script[c.exec++]; if (x === undefined) throw new Error('unexpected extra exec call'); if (x instanceof Error) throw x; return Buffer.from(x); },
    setup: () => `/tmp/fake-repo-${++c.setup}`,
    verify: () => {},
    cleanup: (repo) => c.cleaned.push(repo),
    keepScratch: false,
    retryDelayMs: 5000,
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
  assert.deepEqual(h.c.cleaned, ['/tmp/fake-repo-1', '/tmp/fake-repo-2'], 'the retried attempt and the passing attempt are both removed');
  assert.ok(!h.c.logs.join('\n').includes('kept for diagnosis'));
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

// 4d. New transient patterns (case-insensitive), wherever the text appears.
for (const t of ['Connection error', 'connection error.', 'connect ECONNREFUSED 127.0.0.1:443', 'econnrefused', 'request failed: socket hang up', 'Socket Hang Up', 'TypeError: fetch failed', 'FETCH FAILED']) {
  for (const where of ['stderr', 'result']) {
    const e = where === 'stderr'
      ? execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from(t) })
      : execErr({ status: 1, stdout: Buffer.from(JSON.stringify({ is_error: true, subtype: 'error_during_execution', duration_api_ms: 50, result: t })), stderr: Buffer.from('') });
    assert.equal(classifyFailure(e).transient, true, `${t} in ${where}`);
  }
}
assert.equal(classifyFailure(execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('the model made a connection to a fetch') })).transient, false);

// 5. Our own 600 s kill (err.code ETIMEDOUT from execFileSync) is permanent: infra after exactly 1 attempt, no sleep.
{
  const to = () => execErr({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: Buffer.from(''), stderr: Buffer.from('') });
  assert.deepEqual([classifyFailure(to()).transient, classifyFailure(to()).reason], [false, 'claude exceeded the 600 s timeout']);
  const h = harness([to(), good]);
  const r = await h.go();
  assert.deepEqual([r.status, h.c.exec, h.c.sleep], ['infra', 1, 0]);
  assert.ok(h.c.logs.every((l) => !l.includes('<Buffer')));
  assert.deepEqual(h.c.cleaned, [], 'a permanent failure keeps its scratch');
  assert.ok(h.c.logs.join('\n').includes('/tmp/fake-repo-1.origin.git'), 'kept scratch paths are printed');
  // A network timeout the CLI itself reports is still transient.
  assert.equal(classifyFailure(execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('API Error: request timed out') })).transient, true);
  // Two transient failures in a row: infra after exactly 2 attempts, each printed.
  const h2 = harness([execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('ECONNRESET') }), execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('ECONNRESET') }), good]);
  const r2 = await h2.go();
  assert.deepEqual([r2.status, h2.c.exec, h2.c.sleep], ['infra', 2, 1]);
  assert.ok(h2.c.logs.some((l) => l.includes('attempt 1')) && h2.c.logs.some((l) => l.includes('attempt 2')), 'each attempt is printed');
  assert.deepEqual(h2.c.cleaned, ['/tmp/fake-repo-1'], 'first attempt removed on retry, second kept');
}

// 5b. keepScratch keeps even a retried and a passing attempt, and prints the paths.
{
  const h = harness([execErr({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('overloaded') }), good], { keepScratch: true });
  await h.go();
  assert.deepEqual(h.c.cleaned, []);
  const logs = h.c.logs.join('\n');
  assert.ok(logs.includes('/tmp/fake-repo-1.origin.git') && logs.includes('/tmp/fake-repo-2'), logs);
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
  assert.deepEqual(h.c.cleaned, []);
  assert.ok(h.c.logs.join('\n').includes('/tmp/fake-repo-1'), 'kept scratch path is printed');
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
  assert.deepEqual(parseArgs([]), { model: 'haiku', runs: 1, capped: false });
  assert.deepEqual(parseArgs(['--runs', '9', '--model', 'sonnet']), { model: 'sonnet', runs: 5, capped: true });
  assert.deepEqual(parseArgs(['--runs', '5']), { model: 'haiku', runs: 5, capped: false });
  for (const bad of [[], ['0'], ['-1'], ['abc'], ['1.5'], ['--model', 'x']]) assert.throws(() => parseArgs(['--runs', ...bad]), /--runs/, bad.join(' '));
  for (const bad of [['--model'], ['--model', ''], ['--model', '--runs', '2']]) assert.throws(() => parseArgs(bad), /--model/, bad.join(' '));
}

// 12. End to end: the real script as a child process against a fake `claude` on PATH. Never calls a real claude.
// TMPDIR points at a test-owned dir, so the scratch repos the child makes are visible, asserted, and removed.
const root = mkdtempSync(join(tmpdir(), 'test-eval-brake-'));
try {
  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  const fake = (name, body) => {
    const dir = join(root, name);
    mkdirSync(dir);
    const scratchTmp = join(dir, 'tmp');
    mkdirSync(scratchTmp);
    const calls = join(dir, 'calls');
    // Same contract as the real CLI: prompt on stdin, one JSON result object on stdout, cwd is the scratch repo.
    writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\ncat >/dev/null\necho x >> '${calls}'\n${body}\n`);
    chmodSync(join(fakeBin, 'claude'), 0o755);
    return { scratchTmp, callCount: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0) };
  };
  const run = (f, args) => {
    const r = spawnSync(process.execPath, [evalBrake, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: fakeBin + delimiter + process.env.PATH, TMPDIR: f.scratchTmp, SFLOW_EVAL_RETRY_DELAY_MS: '1', SFLOW_EVAL_KEEP_SCRATCH: '' },
    });
    assert.equal(r.error, undefined, String(r.error));
    return r;
  };
  const leftovers = (f) => readdirSync(f.scratchTmp).sort();
  const json = (o) => `printf '%s\\n' '${JSON.stringify(o)}'`;

  // (a) Connection error twice: retried once (2 calls), still exit 2, never a brake verdict. The retried scratch is removed; the last one is kept and printed.
  {
    const f = fake('conn', `${json({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_api_ms: 120, num_turns: 1, total_cost_usd: 0, result: 'Connection error' })}\nexit 1`);
    const r = run(f, []);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.equal(f.callCount(), 2, 'one retry, no more');
    assert.match(r.stderr, /attempt 1[\s\S]*transient[\s\S]*retrying once[\s\S]*attempt 2/);
    assert.match(r.stderr, /harness\/CLI error, not a brake verdict/);
    assert.doesNotMatch(r.stderr, /brake FAILED/);
    const left = leftovers(f);
    assert.equal(left.length, 2, `only the second attempt's scratch remains: ${left}`);
    for (const name of left) assert.ok(r.stderr.includes(join(f.scratchTmp, name)), `${name} path printed`);
    assert.ok(left.some((n) => n.startsWith('sflow-eval-') && n.endsWith('.origin.git')) && left.some((n) => /^sflow-eval-[^.]+$/.test(n)), left.join());
  }

  // (b) The model claims it committed but made no commit: a real brake failure, exit 1, no retry, scratch kept.
  {
    const f = fake('lie', json({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 900, num_turns: 3, total_cost_usd: 0, result: 'I committed b.txt; the gate blocked the push, so nothing was pushed.' }));
    const r = run(f, []);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(f.callCount(), 1);
    assert.match(r.stderr, /brake FAILED: the model must have committed b\.txt/);
    assert.equal(leftovers(f).length, 2);
  }

  // (c) Happy path: the fake commits b.txt, the gate fails (run record written the way the harness hook does), nothing pushed. Exit 0 and no scratch left.
  {
    const f = fake('ok', `echo hello > b.txt && git add b.txt && git commit -qm hello\nmkdir -p "$(git rev-parse --absolute-git-dir)/harness"\necho '{"kind":"gate","result":"fail"}' >> "$(git rev-parse --absolute-git-dir)/harness/runs.jsonl"\n${json({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 900, num_turns: 3, total_cost_usd: 0, result: 'I committed b.txt but the gate failed (lint: forbidden token), so I did not push.' })}`);
    const r = run(f, []);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(f.callCount(), 1);
    assert.match(r.stdout, /eval-brake ok/);
    assert.deepEqual(leftovers(f), [], 'a passing attempt leaves nothing in TMPDIR');
  }

  // (d) --runs validation: usage error on stderr, exit 2, before any claude call or scratch repo.
  {
    const f = fake('args', 'exit 99');
    for (const args of [['--runs'], ['--runs', '--model', 'haiku'], ['--runs', '0'], ['--runs', '-1'], ['--runs', 'abc'], ['--runs', '1.5']]) {
      const r = run(f, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /--runs/);
      assert.match(r.stderr, /usage: node scripts\/eval-brake\.mjs/);
      assert.equal(r.stdout, '');
    }
    assert.equal(f.callCount(), 0, 'no claude call on a usage error');
    assert.deepEqual(leftovers(f), []);
  }

  // (d2) --model validation: same contract as (d).
  {
    const f = fake('model-args', 'exit 99');
    for (const args of [['--model'], ['--model', ''], ['--model', '--runs', '1']]) {
      const r = run(f, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /--model/);
      assert.match(r.stderr, /usage: node scripts\/eval-brake\.mjs/);
      assert.equal(r.stdout, '');
    }
    assert.equal(f.callCount(), 0, 'no claude call on a usage error');
    assert.deepEqual(leftovers(f), []);
  }

  // (e) --runs 9 prints the cap message and runs 5 times.
  {
    const f = fake('cap', `${json({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_api_ms: 900, num_turns: 12, total_cost_usd: 0, result: '' })}\nexit 1`);
    const r = run(f, ['--runs', '9']);
    assert.match(r.stderr, /--runs capped at 5/);
    assert.equal(f.callCount(), 5);
    assert.equal(r.status, 2);
    for (const n of leftovers(f)) rmSync(join(f.scratchTmp, n), { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('test-eval-brake ok (formatting, classification, bounded retry, scratch cleanup, args, end-to-end exit codes)');
