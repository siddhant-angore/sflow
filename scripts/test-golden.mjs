// SID-171: golden files are updated only through the very_good MCP `test` tool (update_goldens: true). Pipes events through
// hooks/harness/golden.mjs and asserts the decision. Run: node scripts/test-golden.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch as makeScratch } from './scratch.mjs';

const hook = new URL('../hooks/harness/golden.mjs', import.meta.url).pathname;
const call = (ev, input = JSON.stringify(ev), env = process.env) => {
  const r = spawnSync('node', [hook], { input, cwd: ev?.cwd ?? process.cwd(), env });
  const out = r.stdout.toString().trim();
  return { status: r.status, out: out ? JSON.parse(out) : null, err: r.stderr.toString() };
};
const decision = (r) => r.out?.hookSpecificOutput?.permissionDecision ?? 'allow';
const reasonOf = (r) => r.out?.hookSpecificOutput?.permissionDecisionReason ?? '';
const sh = (cwd, c) => execFileSync('sh', ['-c', c], { cwd, stdio: 'pipe' }).toString().trim();
const put = (root, rel, text, mode) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); if (mode !== undefined) chmodSync(p, mode); return p; };

// A Flutter app with every kind of regen route, and harmless neighbours.
const app = makeScratch('golden-app-');
sh(app, 'git init -q -b main');
put(app, 'pubspec.yaml', 'name: app\n');
put(app, 'tool/regen_goldens.sh', '#!/bin/sh\nflutter test --update-goldens\n', 0o755);
put(app, 'tool/outer.sh', '#!/bin/sh\ncd "$(dirname "$0")/.." && sh tool/inner.sh\n', 0o755);
put(app, 'tool/inner.sh', 'flutter test test/golden --update-goldens\n');
put(app, 'tool/env.sh', 'UPDATE_GOLDENS=1 flutter test\n');
put(app, 'tool/regen.dart', 'import "dart:io";\nvoid main() { Process.runSync("flutter", ["test", "--update-goldens"]); }\n');
put(app, 'tool/regen.py', 'import subprocess\nsubprocess.run(["flutter", "test", "--update-goldens"])\n');
put(app, 'tool/regen.mjs', 'import { execSync } from "node:child_process";\nexecSync("flutter test --update-goldens");\n');
put(app, 'bin/regen.dart', 'void main() { /* autoUpdateGoldenFiles = true; */ }\n');
put(app, 'bin/app.dart', 'void main() {}\n');
put(app, 'tool/ok.sh', '#!/bin/sh\nflutter test\n', 0o755);
put(app, 'tool/ok.dart', 'void main() {}\n');
put(app, 'tool/bin.exe', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2]), 0o755);
put(app, 'tool/locked.sh', 'flutter test\n', 0o000);
put(app, 'test/widget_test.dart', 'void main() {}\n');
const mk = makeScratch('golden-mk-'); put(mk, 'pubspec.yaml', 'name: mk\n');
put(mk, 'Makefile', 'include rules.mk\ntest:\n\tflutter test\n'); put(mk, 'rules.mk', 'goldens:\n\tflutter test --update-goldens\n');
put(mk, 'sub/Makefile', 'goldens:\n\tsh ../tool/inner.sh\n'); put(mk, 'tool/inner.sh', 'flutter test --update-goldens\n');
put(mk, 'other.mk', 'g:\n\tflutter test --update-goldens\n');
const inc = makeScratch('golden-inc-'); put(inc, 'pubspec.yaml', 'name: i\n'); put(inc, 'Makefile', 'include common.inc\n'); put(inc, 'common.inc', 'g:\n\tUPDATE_GOLDENS=1 flutter test\n');
const ws = makeScratch('golden-ws-'); put(ws, 'pubspec.yaml', 'name: ws\n'); put(ws, 'melos.yaml', 'name: ws\nscripts:\n  goldens: melos exec -- flutter test --update-goldens\n');
const ws7 = makeScratch('golden-ws7-'); put(ws7, 'pubspec.yaml', 'name: ws\nmelos:\n  scripts:\n    goldens: flutter test --update-goldens\n');
put(ws7, 'packages/a/pubspec.yaml', 'name: a\n');
const npm = makeScratch('golden-npm-'); put(npm, 'pubspec.yaml', 'name: n\n'); put(npm, 'package.json', '{"scripts":{"goldens":"flutter test --update-goldens"}}\n');
const just = makeScratch('golden-just-'); put(just, 'pubspec.yaml', 'name: j\n'); put(just, 'justfile', 'goldens:\n  flutter test --update-goldens\n');
const cfg = makeScratch('golden-cfg-'); put(cfg, 'pubspec.yaml', 'name: c\n');
put(cfg, 'test/flutter_test_config.dart', 'import "dart:async";\nimport "package:flutter_test/flutter_test.dart";\nFuture<void> testExecutable(FutureOr<void> Function() m) async { autoUpdateGoldenFiles = true; await m(); }\n');
const plain = makeScratch('golden-plain-'); sh(plain, 'git init -q -b main'); put(plain, 'tool/regen.sh', 'flutter test --update-goldens\n', 0o755); put(plain, 'Makefile', 'g:\n\tflutter test --update-goldens\n');

const bash = (command, cwd = app) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const mustDeny = [
  // the flag, an env or define, however it is wrapped
  ['flutter test --update-goldens', app], ['flutter test --update-goldens test/golden', app], ['fvm flutter test --update-goldens', app], ['very_good test --update-goldens', app],
  ['dart test --update-goldens', app], ['flutter test --update-golden', app], ["bash -c 'flutter test --update-goldens'", app], ['sh -c "cd . && flutter test --update-goldens"', app],
  ['eval "flutter test --update-goldens"', app], ['timeout 600 env CI=1 flutter test --update-goldens', app], ['echo flutter test --update-goldens | sh', app],
  ['UPDATE_GOLDENS=1 flutter test', app], ['GOLDEN_UPDATE=1 flutter test', app], ['env UPDATE_GOLDENS=true flutter test', app], ['flutter test --dart-define=UPDATE_GOLDENS=true', app], ['flutter test --dart-define=updateGoldens=true', app],
  ["cat > test/flutter_test_config.dart <<'EOF'\nFuture<void> testExecutable(f) async { autoUpdateGoldenFiles = true; await f(); }\nEOF", app],
  ['flutter test --update-goldens', plain], ['bash -c "flutter test --update-goldens"', plain],
  // a script file the guard can read, run any way
  ['tool/regen_goldens.sh', app], ['./tool/regen_goldens.sh --all', app], ['bash tool/regen_goldens.sh', app], ['sh -e tool/regen_goldens.sh', app], ['bash -x -- tool/regen_goldens.sh', app],
  ['source tool/env.sh', app], ['. tool/env.sh', app], ['sh -c "tool/regen_goldens.sh"', app], ["bash -lc 'source tool/env.sh'", app], ['nohup tool/regen_goldens.sh', app],
  ['xargs -0 sh tool/regen_goldens.sh', app], ['cd tool && ./regen_goldens.sh', app], ['cd tool && sh inner.sh', app], ['sh tool/outer.sh', app], ['bash < tool/inner.sh', app], ['cat tool/inner.sh | bash', app],
  [`${app}/tool/regen_goldens.sh`, plain], ['dart run tool/regen.dart', app], ['dart tool/regen.dart', app], ['dart run regen', app], ['dart run app:regen', app], ['flutter pub run regen', app], ['dart pub run tool/regen.dart', app],
  ['python3 tool/regen.py', app], ['node tool/regen.mjs', app],
  // task runners: the file they read
  ['make goldens', mk], ['make g', inc], ['make', mk], ['make -C sub goldens', mk], ['make -f other.mk g', mk], ['make --file=other.mk g', mk], ['cd sub && make', mk],
  ['melos run goldens', ws], ['melos goldens', ws], ['melos run goldens', ws7], ['cd packages/a && melos run goldens', ws7],
  ['npm run goldens', npm], ['yarn goldens', npm], ['just goldens', just],
  // flutter test with a committed config that turns updating on
  ['flutter test', cfg], ['very_good test', cfg], ['dart test', cfg], ['fvm flutter test test/x_test.dart', cfg],
  // can't tell: deny
  ['tool/bin.exe', app], ['cd "$DIR" && make goldens', app], ['cd $(mktemp -d) && ./x.sh', app],
];
if (process.getuid?.() !== 0) mustDeny.push(['sh tool/locked.sh', app]);
const mustAllow = [
  ['flutter test', app], ['flutter test test/widget_test.dart', app], ['fvm flutter test', app], ['very_good test --coverage', app], ['dart test', app], ['flutter analyze', app], ['dart format .', app],
  ['tool/ok.sh', app], ['sh tool/ok.sh', app], ['/bin/sh tool/ok.sh', app], ['dart run tool/ok.dart', app], ['dart run app', app], ['dart run build_runner build --delete-conflicting-outputs', app],
  ['make test', makeScratch('golden-mkok-')], ['git status', app], ['ls tool', app], ['cat tool/inner.sh', app], ['/bin/ls', app], ['dart pub get', app], ['flutter pub get', app],
  ['tool/missing.sh', app], ['cd "$DIR" && ls', app], ['cd "$DIR" && git status', plain],
  // outside a Dart repo files aren't read: only the command text is checked
  ['make g', plain], ['tool/regen.sh', plain], ['sh tool/regen.sh', plain], ['cd "$TMPDIR" && make', plain],
  // commit messages and greps that describe golden work in plain words
  ['git commit -m "test: refresh golden images"', app], ['git commit -m "update goldens for the new theme"', app],
];
put(mustAllow[13][1], 'pubspec.yaml', 'name: ok\n'); put(mustAllow[13][1], 'Makefile', 'test:\n\tflutter test\n');
for (const [c, cwd] of mustDeny) {
  const r = call(bash(c, cwd));
  assert.ok(decision(r) === 'deny' || r.status === 2, `must deny: ${c} (in ${cwd}) -> ${JSON.stringify(r.out)} ${r.err}`);
  assert.match(reasonOf(r), /SID-171/, `deny reason names SID-171: ${c}`);
}
for (const [c, cwd] of mustAllow) {
  const r = call(bash(c, cwd));
  assert.equal(decision(r), 'allow', `must allow: ${c} (in ${cwd}) -> ${reasonOf(r)} ${r.err}`);
  assert.equal(r.status, 0, `exit 0: ${c}`);
}
assert.match(reasonOf(call(bash('flutter test --update-goldens'))), /very_good MCP `test` tool and `update_goldens: true`/, 'the deny names the sanctioned route');

// File tools: content that switches updating on, in code or config; prose is fine.
const fileDeny = [
  { tool_name: 'Write', tool_input: { file_path: join(app, 'test/flutter_test_config.dart'), content: 'Future<void> testExecutable(f) async { autoUpdateGoldenFiles = true; await f(); }' } },
  { tool_name: 'Edit', tool_input: { file_path: join(app, 'test/flutter_test_config.dart'), old_string: 'x', new_string: 'autoUpdateGoldenFiles = true;' } },
  { tool_name: 'MultiEdit', tool_input: { file_path: join(app, 'tool/ok.sh'), edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'flutter test', new_string: 'flutter test --update-goldens' }] } },
  { tool_name: 'Write', tool_input: { file_path: join(app, 'Makefile'), content: 'g:\n\tflutter test --update-goldens\n' } },
  { tool_name: 'Write', tool_input: { file_path: join(app, 'melos.yaml'), content: 'scripts:\n  g: UPDATE_GOLDENS=1 flutter test\n' } },
  { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(app, 'n.ipynb'), new_source: '!flutter test --update-goldens' } },
  { tool_name: 'Write', tool_input: { file_path: join(plain, 'x.sh'), content: 'flutter test --update-goldens' } },
];
const fileAllow = [
  { tool_name: 'Write', tool_input: { file_path: join(app, 'test/flutter_test_config.dart'), content: 'Future<void> testExecutable(f) async { await f(); }' } },
  { tool_name: 'Write', tool_input: { file_path: join(app, 'docs/goldens.md'), content: 'Never run flutter test --update-goldens here; use the very_good MCP.' } },
  { tool_name: 'Edit', tool_input: { file_path: join(app, 'CHANGELOG.md'), old_string: 'x', new_string: 'autoUpdateGoldenFiles is denied' } },
  { tool_name: 'Edit', tool_input: { file_path: join(app, 'lib/main.dart'), old_string: 'a', new_string: 'b' } },
];
for (const ev of fileDeny) { const r = call({ ...ev, cwd: app }); const f = ev.tool_input.file_path ?? ev.tool_input.notebook_path; assert.equal(decision(r), 'deny', `must deny ${ev.tool_name} ${f}`); assert.match(reasonOf(r), /SID-171/); assert.ok(reasonOf(r).includes(f), `the deny names ${f}`); }
assert.equal(decision(call({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(app, 'notes.md'), new_source: 'flutter test --update-goldens' }, cwd: app })), 'allow', 'NotebookEdit path is read for the prose exemption');
for (const ev of fileAllow) { const r = call({ ...ev, cwd: app }); assert.equal(decision(r), 'allow', `must allow ${ev.tool_name} ${ev.tool_input.file_path}: ${reasonOf(r)}`); }

// Fail closed: unreadable events and internal errors deny with exit 2 and the JSON deny.
for (const input of ['not json', '', 'null', '7']) {
  const r = call({ cwd: app }, input);
  assert.equal(r.status, 2, `garbage event ${JSON.stringify(input)} exits 2`);
  assert.equal(decision(r), 'deny', `garbage event ${JSON.stringify(input)} denies`);
  assert.match(reasonOf(r), /failing closed/);
}
const nul = call(bash('tool/ok.sh\u0000x'));
assert.ok(nul.status === 2 || decision(nul) === 'deny' || nul.status === 0, 'a NUL in the command never crashes open');
const big = makeScratch('golden-big-'); put(big, 'pubspec.yaml', 'name: b\n');
for (let i = 0; i < 450; i++) put(big, `t/s${i}.sh`, `sh t/s${i + 1}.sh\n`);
const deep = call(bash('sh t/s0.sh', big)); // a long chain: past depth 4 it isn't followed, so this one is allowed
assert.equal(decision(deep), 'allow', 'a chain deeper than 4 is not followed');
const wide = makeScratch('golden-wide-'); put(wide, 'pubspec.yaml', 'name: w\n');
put(wide, 'run.sh', Array.from({ length: 450 }, (_, i) => `sh t/s${i}.sh`).join('\n') + '\n'); for (let i = 0; i < 450; i++) put(wide, `t/s${i}.sh`, 'true\n');
const w = call(bash('sh run.sh', wide));
assert.equal(w.status, 2, 'too many files to inspect fails closed (exit 2)'); assert.match(reasonOf(w), /failing closed\): too many files/);

// Registered for Bash and every file tool, in the generated hooks.json.
const pre = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse;
const entry = pre.find((e) => e.hooks.some((h) => h.command.includes('golden.mjs')));
assert.ok(entry, 'golden.mjs is registered');
for (const t of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(new RegExp(`^(?:${entry.matcher})$`).test(t), `golden.mjs matches ${t}`);
assert.ok(!new RegExp(`^(?:${entry.matcher})$`).test('mcp__plugin_flutter_very-good-cli__test'), 'the very_good MCP test tool is not matched (it is the sanctioned route)');
console.log(`golden ok (${mustDeny.length} deny, ${mustAllow.length} allow, ${fileDeny.length + fileAllow.length} file-tool cases)`);
