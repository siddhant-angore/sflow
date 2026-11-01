// PreToolUse(Bash|Edit|Write|MultiEdit|NotebookEdit), SID-171: golden files are updated one way only, the very_good MCP `test` tool with
// `update_goldens: true` (an MCP call, so this hook never sees it). Everything else that would rewrite goldens is denied, however it is invoked:
// `flutter test --update-goldens` (also via bash -c, sh, eval, make, melos, dart run, npm run, or a script file), an `autoUpdateGoldenFiles` switch
// (a flutter_test_config.dart, a heredoc, an inline script), or an update-goldens env/define (UPDATE_GOLDENS=1, --dart-define=UPDATE_GOLDENS=true).
// The Bash check reads the whole command; in a Dart repo (a pubspec.yaml or melos.yaml at or above the cwd) it also reads every local file the
// command runs (scripts, Makefiles, melos.yaml, package.json, flutter_test_config.dart for flutter test) and follows the files those name.
// It fails closed: a file that exists but can't be read, a binary it can't inspect, a cd it can't follow, too many files, or any error denies.
// Tighten-only. An allowlisted regen script would be a loosening and is Siddhant's call (SID-153).
const failClosed = (e) => {
  const why = `harness hook error (failing closed): ${String(e?.message ?? e).split('\n')[0]}; blocked (SID-171 golden-update check)`;
  try { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }) + '\n'); } catch {}
  process.stderr.write(why + '\n');
  process.exit(2);
};
process.on('uncaughtException', failClosed);
try {
  const { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } = await import('node:fs');
  const { basename, dirname, extname, isAbsolute, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { deny, segments } = await import('./lib.mjs');
  const { simpleCommands } = await import('./guard-rules.mjs');
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch (e) { throw new Error(`unreadable hook event (${e.message})`); }
  if (!ev || typeof ev !== 'object') throw new Error('unreadable hook event');
  const GOLDEN = /update[-_:.]?goldens?|goldens?[-_:.]?update/i; // --update-goldens, autoUpdateGoldenFiles, UPDATE_GOLDENS, updateGoldens, golden_update
  const SANCTIONED = 'update goldens only with the very_good MCP `test` tool and `update_goldens: true` (Very Good CLI >= 1.5.0), then review the changed PNGs before committing; a declared regen script is not allowlisted (SID-153, Siddhant\'s call)';
  const no = (what) => { deny(`harness: ${what} (SID-171). ${SANCTIONED}`); process.exit(0); };
  const cwd = resolve(ev.cwd || process.cwd());
  const tool = ev.tool_name;
  if (tool === 'Bash') {
    const cmd = String(ev.tool_input?.command ?? '');
    const m = GOLDEN.exec(cmd);
    if (m) no(`this command would update golden files ("${m[0]}")`);
    const dartAt = (d) => { for (let x = d; ; x = dirname(x)) { if (existsSync(join(x, 'pubspec.yaml')) || existsSync(join(x, 'melos.yaml'))) return x; if (dirname(x) === x) return null; } };
    // Read a local file the command runs. Missing: nothing runs, nothing to check. Exists but unreadable or binary: can't tell, deny.
    const seen = new Set(); let budget = 400;
    const SHELLISH = /\.(sh|bash|zsh|mk|ya?ml|json)$|^(GNUmakefile|makefile|Makefile|justfile|Justfile|Taskfile)/;
    const inspect = (file, depth = 0) => {
      const f = resolve(file);
      if (seen.has(f)) return; seen.add(f);
      if (--budget < 0) throw new Error('too many files to inspect');
      let st; try { st = statSync(f); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
      if (st.isDirectory()) return;
      if (st.size > 4 << 20) throw new Error(`${file} is too large to inspect`);
      const buf = readFileSync(f);
      if (buf.subarray(0, 8192).includes(0)) { const root = dartAt(dirname(f)); if (!root) return; } // a system binary outside any Dart project
      if (buf.subarray(0, 8192).includes(0)) no(`${file} is a binary the guard can't inspect for golden updates; run it outside Claude`);
      const text = buf.toString('utf8'), hit = GOLDEN.exec(text);
      if (hit) no(`${file} updates golden files ("${hit[0]}")`);
      if (depth >= 4) return;
      // Files this one names: relative to its own dir and to the cwd (scripts often cd to the repo root first).
      const shellish = SHELLISH.test(basename(f)) || /^#!.*\b(ba|z|da|k)?sh\b/.test(text.slice(0, 200)) || !extname(f);
      if (!shellish && !/\.(dart|py|js|mjs|cjs|rb|pl)$/.test(f)) return;
      for (const [, p] of text.matchAll(/(?:^|[\s"'=(:`])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash|dart|py|mk|js|mjs|cjs|rb|pl))(?=$|[\s"';)&|`])/gm))
        for (const base of new Set([dirname(f), cwd])) inspect(isAbsolute(p) ? p : join(base, p), depth + 1);
    };
    const flutterConfigs = (root) => { // flutter test loads flutter_test_config.dart from the test file's dir and every parent up to the package root
      const out = []; let n = 0;
      const walk = (d, lvl) => {
        let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        for (const x of ents) {
          if (++n > 20000) throw new Error('too many files under the package to look for flutter_test_config.dart');
          if (x.isDirectory() && lvl < 12 && !/^(\.dart_tool|build|\.git|node_modules|\.fvm|ios|android|macos|linux|windows|web)$/.test(x.name)) walk(join(d, x.name), lvl + 1);
          else if (x.name === 'flutter_test_config.dart') out.push(join(d, x.name));
        }
      };
      walk(root, 0); return out;
    };
    let here = cwd;
    const tilde = (p) => p.replace(/^~(?=\/|$)/, homedir());
    for (const seg of segments(cmd)) {
      for (const { w: raw } of simpleCommands(seg)) {
        let w = raw;
        while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w = w.slice(1);
        if (w[0] === 'fvm') w = w[1] === 'spawn' ? w.slice(3) : w.slice(1);
        if (!w.length) continue;
        const name = basename(w[0]), args = w.slice(1), pos = args.filter((a) => !a.startsWith('-'));
        if (name === 'cd' || name === 'pushd') {
          const d = pos[0];
          if (d === undefined) { here = homedir(); continue; }
          here = /[$`*?[]/.test(d) || d === '-' ? null : isAbsolute(tilde(d)) ? tilde(d) : here === null ? null : resolve(here, tilde(d)); continue; // unknown: fail closed only if something runs there

        }
        // files are read only in a Dart repo: the one the command runs in, or the one a file it names lives in
        if (!dartAt(here ?? cwd) && !w.some((a) => a.includes('/') && dartAt(dirname(resolve(here ?? cwd, tilde(a)))))) continue;
        const dir = () => { if (here === null) throw new Error("can't follow a `cd` to check what this command runs"); return here; };
        const at = (p) => isAbsolute(tilde(p)) ? tilde(p) : resolve(dir(), tilde(p));
        if (/^(sh|bash|zsh|dash|ksh)$/.test(name)) {
          if (args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) continue; // the -c string is its own segment
          let i = 0; while (i < args.length && args[i].startsWith('-') && args[i] !== '--') i += /^[-+]o$/.test(args[i]) ? 2 : 1;
          if (args[i] === '--') i++;
          if (args[i] !== undefined) { inspect(at(args[i])); continue; }
          // A shell reading its script from stdin (`bash < f`, `cat f | sh`): check every existing file the command names.
          for (const t of cmd.split(/[\s<>|;&()]+/).filter((t) => t && !t.startsWith('-') && !/[$`]/.test(t))) inspect(at(t));
          continue;
        }
        if (name === 'source' || name === '.') { if (pos[0]) inspect(at(pos[0])); continue; }
        if (/^(node|nodejs|bun|deno|python[\d.]*|ruby|perl)$/.test(name)) { // inline code is in the command text, already checked
          if (args.some((a) => /^(-[a-zA-Z]*[ecEp]|--eval|--print)$/.test(a) || (name === 'deno' && a === 'eval'))) continue;
          const f = pos.find((p) => p !== 'run'); if (f) inspect(at(f)); continue;
        }
        if (name === 'make' || name === 'gmake') {
          let mdir = dir(); const files = [];
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '-C' || a === '--directory') mdir = resolve(mdir, tilde(args[++i] ?? '.'));
            else if (/^-C./.test(a)) mdir = resolve(mdir, tilde(a.slice(2)));
            else if (a.startsWith('--directory=')) mdir = resolve(mdir, tilde(a.slice(12)));
            else if (a === '-f' || a === '--file' || a === '--makefile') files.push(args[++i] ?? '');
            else if (/^-f./.test(a)) files.push(a.slice(2));
            else if (/^--(?:make)?file=/.test(a)) files.push(a.replace(/^--(?:make)?file=/, ''));
          }
          for (const f of files.length ? files : ['GNUmakefile', 'makefile', 'Makefile']) inspect(resolve(mdir, tilde(f)));
          for (const f of [...seen].filter((s) => /akefile|\.mk$/.test(s) && existsSync(s))) for (const [, inc] of readFileSync(f, 'utf8').matchAll(/^\s*-?include\s+(.+)$/gm)) for (const p of inc.trim().split(/\s+/)) { if (/[$*?]/.test(p)) throw new Error(`can't follow the Makefile include ${p}`); inspect(resolve(dirname(f), p)); }
          continue;
        }
        if (name === 'melos') { for (let x = dir(); ; x = dirname(x)) { inspect(join(x, 'melos.yaml')); inspect(join(x, 'pubspec.yaml')); if (existsSync(join(x, 'melos.yaml')) || dirname(x) === x) break; } continue; }
        if (/^(npm|pnpm|yarn|bun|npx)$/.test(name)) { for (let x = dir(); ; x = dirname(x)) { if (existsSync(join(x, 'package.json'))) { inspect(join(x, 'package.json')); break; } if (dirname(x) === x) break; } continue; }
        if (/^(just|task)$/.test(name)) { for (const f of ['justfile', 'Justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml']) inspect(join(dir(), f)); continue; }
        if (name === 'dart' || name === 'flutter' || name === 'very_good') {
          const sub = pos[0];
          const pkg = dartAt(dir()) ?? dir();
          if (sub === 'test' || (name === 'very_good' && sub === 'test')) { for (const f of flutterConfigs(pkg)) inspect(f); continue; }
          // dart run X / dart X.dart / dart pub run X / flutter pub run X
          const runIdx = sub === 'run' ? 1 : sub === 'pub' && pos[1] === 'run' ? 2 : sub && /\.dart$/.test(sub) ? 0 : -1;
          if (runIdx < 0) continue;
          const target = pos[runIdx];
          if (!target) continue;
          if (/\.dart$/.test(target) || target.includes('/')) { inspect(at(target)); continue; }
          const [p, exe = p] = target.split(':'); // own package's bin/<exe>.dart; a dependency's executable is not read (known limit)
          inspect(join(pkg, 'bin', `${exe}.dart`)); if (p !== exe) inspect(join(pkg, 'bin', `${p}.dart`));
          continue;
        }
        if (w[0].includes('/')) inspect(at(w[0])); // ./tool/regen.sh, tool/x: any other command run by path
      }
    }
    process.exit(0);
  }
  // File tools: content that would switch golden updating on, written to anything but prose (docs may describe the recipe).
  const ti = ev.tool_input ?? {};
  const file = String(ti.file_path ?? ti.notebook_path ?? '');
  const texts = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [])].filter((x) => typeof x === 'string');
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(file)) process.exit(0);
  for (const t of texts) { const m = GOLDEN.exec(t); if (m) no(`writing "${m[0]}" into ${file || 'a file'} would update golden files when it runs`); }
} catch (e) { failClosed(e); }
