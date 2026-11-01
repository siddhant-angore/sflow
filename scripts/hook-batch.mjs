#!/usr/bin/env node
// SID-253: one checkout's real pre-bash.mjs over a batch of commands, in one process, so a regression run can afford tens of thousands of verdicts.
// node scripts/hook-batch.mjs <pre-bash.mjs> <cwd> <commands.json> <verdicts.json>. Each verdict is 1 (deny) or 0 (allow).
//
// Each command re-evaluates the entrypoint's own top-level code (a fresh `?n=` module), with its process boundary replaced:
// - fd 0 reads return the event; stdout and fd 1 writes are captured; process.exit throws, and everything the hook does after its first exit is ignored, as a real exit would.
// - git reads are memoized by their arguments, since nothing in a batch changes the repo: the commands are judged, never run.
// The cwd must hold no committed policy. With one the gate would run commands and write its record; execSync is the gate's only use of it here, so it aborts the batch.
// scripts/test-hooks.mjs compares a sample against one real process per command.
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [hook, cwd, inFile, outFile] = process.argv.slice(2);
const commands = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const { readFileSync, writeFileSync, writeSync } = fs;
const realExit = process.exit.bind(process);
const EXIT = Symbol('exit');
let event = '', captured = '', exited = false, code = 0;

const capture = (text) => { if (!exited) captured += text; };
fs.readFileSync = (p, ...rest) => (p === 0 ? event : readFileSync(p, ...rest));
fs.writeSync = (fd, data, off = 0, ...rest) => {
  if (fd !== 1 && fd !== 2) return writeSync(fd, data, off, ...rest);
  const text = Buffer.isBuffer(data) ? data.subarray(off) : data;
  if (fd === 1) capture(text.toString());
  return text.length;
};
process.stdout.write = (text) => { capture(String(text)); return true; };
process.stderr.write = () => true;
process.exit = (c = 0) => { if (!exited) { exited = true; code = c; } throw EXIT; };

const memo = new Map();
const remember = (fn, label) => (...args) => {
  const key = JSON.stringify([label, args]);
  if (!memo.has(key)) { try { memo.set(key, { value: fn(...args) }); } catch (error) { memo.set(key, { error }); } }
  const hit = memo.get(key);
  if (hit.error) throw hit.error;
  return hit.value;
};
cp.execFileSync = remember(cp.execFileSync, 'execFileSync');
cp.spawnSync = remember(cp.spawnSync, 'spawnSync');
cp.execSync = (command) => { writeSync(2, `hook-batch: the hook ran a gate command (${command}); the batch repo must hold no policy\n`); realExit(3); };
syncBuiltinESMExports();

const url = pathToFileURL(hook).href, verdicts = [];
for (const [n, command] of commands.entries()) {
  event = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
  captured = ''; exited = false; code = 0;
  try { await import(`${url}?n=${n}`); } catch (e) {
    if (e !== EXIT) { writeSync(2, `hook-batch: uncaught ${e?.stack ?? e} on ${command.slice(0, 200)}\n`); realExit(4); }
  }
  const out = captured.trim();
  const denied = out ? JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny' : false;
  if (out && !denied) { writeSync(2, `hook-batch: unexpected hook output on ${command.slice(0, 200)}: ${out.slice(0, 200)}\n`); realExit(5); }
  verdicts.push(denied || code === 2 ? 1 : 0);
}
writeFileSync(outFile, JSON.stringify(verdicts));
realExit(0);
