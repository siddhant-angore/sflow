// Scratch dirs for tests that need a real git repo. Every dir made here is removed on every exit path: normal end, a failed assertion, an uncaught
// error, process.exit, SIGINT/SIGTERM. When the run is failing, the paths are printed first so the cause can be reproduced.
// SFLOW_KEEP_TMP=1 keeps them (and says so); scripts/check.mjs still fails a run that kept or leaked any.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = new Set();
let armed = false;

export const keepTmp = () => process.env.SFLOW_KEEP_TMP === '1';

function arm() {
  if (armed) return;
  armed = true;
  process.on('exit', (code) => {
    const left = [...paths].filter((p) => existsSync(p));
    if (!left.length) return;
    const keep = keepTmp();
    if (keep || code !== 0) console.error(`\nscratch ${keep ? 'kept (SFLOW_KEEP_TMP=1)' : `from the failing run (code ${code}), removed after this listing`}:\n${left.map((p) => `  ${p}`).join('\n')}`);
    if (!keep) for (const p of left) rmSync(p, { recursive: true, force: true });
  });
  // A signal skips 'exit' handlers unless we turn it into an exit.
  for (const [sig, n] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.once(sig, () => process.exit(n));
}

// Also registers the sibling `<dir>.origin.git` that tests clone as a local bare origin.
export function scratch(prefix) {
  arm();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  paths.add(dir).add(`${dir}.origin.git`);
  return dir;
}

// For paths made some other way, such as a linked worktree added with `git worktree add`.
export function trackScratch(path) {
  arm();
  paths.add(path);
  return path;
}
