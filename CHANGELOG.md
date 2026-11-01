# Changelog

All notable changes to sflow are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release has an "Upstream pins" table: the commit of every vendored source that the release was built from (`vendor.manifest.json`, locked by `vendor.lock.json`). Credit for the vendored work belongs to its authors; licenses are in `LICENSES/` and attribution is in `NOTICE.md`.

## [Unreleased]

> Each pull request adds its own entry here when it merges. The release step moves them under a version heading.

### Added

- Model budget (SID-143). `templates/pstack-models.md` is a default pstack model sheet: sonnet for workers and reviewers, haiku for mechanical work, and opus only for architecture and final verdicts. It caps effort at `high` and uses no fable. Until now no sheet shipped, so every swarm role fell back to opus at `xhigh`.
  - `npm run model-budget -- install|check [--config <dir>]...` writes the sheet to `<config>/rules/pstack-models.md`, which Claude Code loads every session. `install` keeps a sheet that differs unless `--force`. `check` exits 1 when a config's sheet is missing or names an unknown model or effort.
  - `npm run test:model-budget` covers the tiers and both commands offline, and `npm run check` runs it.
  - The README's "Model budget" section explains the tiers and how to escalate one task.
  - `install --force` backs up a sheet that differs to `pstack-models.md.bak-<UTC timestamp>` (not `.md`, so Claude Code does not load it as a second sheet) and prints the path. A symlink at the sheet path is refused.
  - No guard, permission or settings change.
- Plugin refresh (SID-144). `npm run refresh-install -- refresh|check [--config <dir>]... [--expect <sha>] [--remote <url>]` reinstalls the sflow plugins from merged main after every merge, and checks that every config's `installed_plugins.json` shows main's head commit.
  - `refresh` refuses a marketplace that could install a branch (a `ref`, or a non-GitHub source). It runs `claude plugin marketplace update sflow` and stops unless the clone is at main. It reinstalls each installed `*@sflow` plugin (`uninstall --keep-data`, then `install`, since `update` is a no-op at the same version), then runs `check`.
  - `check` exits 1 on any config whose sflow plugins aren't installed from main, or whose cache dir is missing.
  - README "Maintain" documents it, links it from the release step, and explains how to verify the installed version by hand.
  - `npm run test:refresh-install` runs offline in `npm run check`. All 20 mutations of the script are killed.
  - It writes no files itself. No guard, permission or settings change.
- Usage-limit handling (SID-149). `skills/sflow/usage-handoff.md` (authored in `workflows/sflow/`) covers it:
  - Before large work (a swarm, a multi-file feature, a golden regen), check the remaining Claude Code and Grok Bot usage.
  - Below about 15%, stop at a safe point per Pause safely, put the handoff note on the issue (template included: branch, full head, done and verified, next steps, how to resume), and report the reset time in IST.
  - Siddhant's rule, "Coding without Claude Code": use Claude Code with sflow by default. If it is exhausted, ask Siddhant whether to code without it. Do so only if he says yes, otherwise wait for the reset, then go back to Claude Code. Work done without it still runs the full gate and tests by hand, keeps every guardrail (no `--no-verify`), and says "coded without claude (approved by Siddhant)" in the PR.
  - The Feature, Shipping (new overlay) and Pause safely playbooks and the sflow entry skill reference it. It is docs only: no permission or guard changes.
- Git hooks outside Claude (SID-147). `npm run hooks -- install|check [--repo <dir>]...` installs versioned `pre-commit` and `pre-push` hooks via `core.hooksPath`, so a shell commit or push gets the same guard and gate as the Claude hook. A human runs it once per repo, outside Claude; agents stay denied `git config core.hooksPath`. The `core.hooksPath` override deny now matches the key in any letter case (`git -c core.hookspath=…`, `--config-env CORE.HOOKSPATH=…`, `GIT_CONFIG_KEY_0=core.hookspath`, `GIT_CONFIG_PARAMETERS="'core.hookspath'=…"`), since git config keys are case-insensitive; before, only the camelCase spelling was denied (SID-147 review).
  - The stubs live in `<git common dir>/sflow-hooks/` and call `hooks/harness/git-hook.mjs`. That dispatcher reuses `pre-bash.mjs` and `lib.mjs`: each pushed ref update is judged as the equivalent `git push`, with a non-fast-forward counted as `--force` and a deletion as `--delete`. It then prints `sflow gate ok <sha>` or `sflow gate skipped: <reason>`. pre-commit refuses staged secrets.
  - Existing hooks keep running first. A previous `core.hooksPath` is saved, as an absolute path, in `<git common dir>/sflow-hooks/previous-hooks-path`, and every executable hook already there gets a stub. Either side failing fails the hook. The saved path is not a git config value, because an agent can run `git config`; the guard denies shell writes into `.git/sflow-hooks` (SID-155). It is checked again on every run: it has to resolve, following symlinks, inside the git dir or the working tree, and never to the stubs. Otherwise the hook fails closed. Install refuses a previous `core.hooksPath` outside the repo and changes nothing.
  - No environment variable bypasses the hooks, the stubs fail closed if the sflow checkout is gone, and `check` exits 1 when the hooks are not installed, stale, or not executable.
  - The push gate's secret patterns moved into `lib.mjs` (`SECRET_PATTERNS`, `secretsInDiff`), so the two scans cannot drift.
  - Guard tightening, so one command can't turn the hooks off (tighten-only; nothing main denied becomes allowed). The Bash guard now also denies `git config --remove-section`/`--rename-section` naming `core` or `sflow` (both directions, any case, including the `remove-section` subcommand form), writes to `core.hooksPath` in any letter case, writes to `sflow.*` keys, and `git config -e`/`--edit`/`edit`. `git config --get …`, other sections and ordinary keys stay allowed.
  - `npm run test:git-hooks` covers all of this against temp repos with a local bare origin. That includes parity with the Claude guard for feature, protected, `HEAD:`, local-main, force, `+refspec` and delete pushes. `npm run check` runs it.

### Changed

- `addyosmani/agent-skills` bumped from `eb07f19f52c2` to [`8bfcc1f9916f`](https://github.com/addyosmani/agent-skills/commit/8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e) (upstream 0.6.15; 12 vendored files change and one is added, the lock goes from 916 to 917 files). `constraint-driven-development` wires `npm run check:security` and `npm run check:a11y` through the new `scripts/quality-gate.mjs` (#694), which only reads a semgrep or axe JSON report and exits 0 (below threshold), 1 (blocking findings) or 2 (unusable report or invocation), and adds a "run the real CI command against a known violation and a clean control" step; `test-driven-development` says to exercise the real boundary for crash and rollback behavior (#750); `security-and-hardening` adds session cookies to its description (#759) and, with `git-workflow-and-versioning`, `references/security-checklist.md` and `hardening-patterns.md`, the staged-secret scan now lists file names only (`git diff --cached -i -G... --name-only`) so credentials are not echoed (#718); `doubt-driven-development` says to strip reasoning but keep contradicting evidence (#754); `context-engineering` replaces the fixed 75% trim point with "compact well before the host's limit" (#739); `browser-testing-with-devtools` waits for fonts and resize observers to settle before measuring layout after a viewport or font change, and `references/accessibility-checklist.md` states the large-text contrast thresholds precisely (#733); `shipping-and-launch` types the `ErrorBoundary` example with `React.PropsWithChildren` (#683); `git-workflow-and-versioning` also applies to inline diffs (#620). (SID-106)
- Harness tests: the round-7 regression templates (brace forms, `sort -o`, `uniq -`, `git log --output`, `sort --co=`) also run as `true; <template>` and `<template>; <body>` (SID-110). The guard must deny every `<template>; <body>` on a feature and a protected branch. Generated combinations go from 858 to 1144, and the ones that assert go from 686 to 873. The guard is unchanged, nothing is newly allowed, and the allowlist is unchanged.
- `mattpocock/skills` bumped from `a496f5513d4a` to [`4ae2317ddb22`](https://github.com/mattpocock/skills/commit/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d) (SID-150). This takes 2 upstream commits:
  - [`5ae4816`](https://github.com/mattpocock/skills/commit/5ae4816) (#1363): `chief-of-staff` looks for a shared wiki first, and runs `retro` and `to-spec`/`to-tickets`/`implement-spec` as procedures by relative path. All four skills are vendored beside it.
  - [`4ae2317`](https://github.com/mattpocock/skills/commit/4ae2317) (#1316): a new `software-factory` skill (6 Markdown files), with `disable-model-invocation: true`. It adds no scripts, network use or file writes.
  - The lock goes from 917 to 923 files. `docs/skill-map.md` lists the new skill. Credit: Matt Pocock, MIT.

### Fixed

- Harness: text piped into a shell is now scanned as commands (SID-107, security). On 0.5.0 `echo 'git reset --hard' | sh` ran, because quoted text was treated as data whenever a segment was not itself a command. When a line has a segment that reads its script from stdin or a process substitution (`| sh`, `| bash -s`, `tee >(sh)`, `> >(sh)`, `sh <(...)`, `source <(...)`, `| source /dev/stdin`, `xargs sh -c` with `{}`/the `-I` string/positional args, or a `sh -c`/`eval` payload built from `$( )` or backticks), every quoted string (with `\n`/`\t` escapes decoded) and the arguments of the other segments go through the guard rules. `curl ... | sh`, `echo ls | sh`, `printf 'echo hi\n' | sh`, `cat script.sh | bash`, `echo hi | tee >(wc -l)`, `eval "$(ssh-agent -s)"` and `find ... | xargs -I{} git add {}` stay allowed.
- Harness: an unquoted glob that can match an option-named file is denied in git transport commands (SID-108, security). `git push [-]-e* origin feat/x` with a file named `--e=<cmd>` in the directory ran `<cmd>` as the receive-pack. `git push|fetch|pull|clone|ls-remote|archive|submodule` now refuse an unquoted word that starts with `*`, `?`, or a `[...]` set containing `-`, `!` or `^`; quote it or spell the names out. `git push origin feat/*`, quoted refspec globs, and globs in other commands (`git add *.mjs`) stay allowed.
- `npm run check` left scratch behind in the temp dir on every run: the `harness-test-*` and `harness-solo-*` repos with their `.origin.git` bare origins, three `harness-main-*` baseline dirs, `plain-*`, and the sibling `wt-*` linked worktree from `scripts/test-hooks.mjs`, about 9 entries and 2.2 MB per run. The tests now make these through `scripts/scratch.mjs`, which removes them on every exit path (normal end, a failed assertion, an uncaught error, `process.exit`, SIGINT/SIGTERM). A failing run prints the scratch paths first and then removes them, so failures no longer leak either; set `SFLOW_KEEP_TMP=1` to keep them for debugging (they are listed as kept). `scripts/check.mjs` runs every step with `TMPDIR` set to one per-run directory and fails the run, listing the entries, if any step leaves something in it (a kept dir counts too). A per-run parent is used rather than a before/after snapshot of the shared temp dir, so entries other runs or tools create there at the same time cannot trip it and no prefix list has to be kept in sync. (SID-55)
- Harness: a committed `.harness.json` that exists but can't be used no longer falls through or throws (SID-82, SID-83, security).
  - On 0.5.0, a policy over 1 MB was skipped silently: `git show` hit the 1 MB buffer. The next candidate (for example a permissive `origin/master`) became the policy, or none did and the gate was skipped.
  - Now `git cat-file -s` decides. A missing file falls through as before. A file over 1 MB, unreadable, not valid JSON, or not an object makes that branch's policy *broken*: strict defaults apply.
  - `pre-bash` still denies every command, exactly as a parse error did, but now names the reason and says a human fixes it on the base branch and runs `git fetch origin`. Nothing that was denied becomes allowed. SessionStart shows the note.
- sflow-flutter hook commands quote `"${CLAUDE_PLUGIN_ROOT}"` so they run when the plugin path contains a space (the five `bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/<x>.sh` commands split at the space). Applied as an sflow overlay (`workflows/flutter-hooks-quoting.md`, a `target:` overlay, now checked for valid JSON) to the file vendored from VeryGoodOpenSource/vgv-ai-flutter-plugin (MIT, credit Very Good Ventures); `NOTICE.md` and `domains/flutter/NOTICE.md` list the file as carrying an sflow change. `scripts/test-plugin-root-space.mjs` runs every hook command of both plugins from a root path with a space, and fails on the old unquoted form. (SID-49)
- The sflow-flutter `flutter-reviewer` agent's frontmatter hook now quotes `"${CLAUDE_PLUGIN_ROOT}"` (`bash "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/allow-readonly-git.sh"`). When the plugin path had a space, the unquoted command could not find its script, so the read-only restriction on the agent's Bash never ran.
  - The fix is a second `target:` overlay, `workflows/flutter-reviewer-hook-quoting.md`, and NOTICE lists the change.
  - `scripts/test-plugin-root-space.mjs` now also runs every `hooks:` command in the frontmatter of both plugins' agents (`agents/*.md`) and skills (`skills/*/SKILL.md`). A self-check confirms it catches the old unquoted form.
  - This is the only frontmatter hook in either plugin. (SID-49)
- Both plugins now declare the sflow mark as their icon (`icon` in `plugin.json`, `assets/sflow-mark.png` and `domains/flutter/assets/sflow-mark.png`), clearing `ICON_MISSING`. The borrowed pstack logo (`assets/logo.png`, vendored from cursor/plugins/pstack) is no longer vendored: its manifest entry is gone and the lock goes from 923 to 922 files. (SID-49)
- Harness: the file tools can't write git hook files (SID-162, security; found by sflow Engineer). The shell guard already denied writes into hooks dirs, but `Write`, `Edit` and `MultiEdit` went through the policy hook, which only checked the policy files, so an agent could create `.git/hooks/pre-commit` (or a `.git/sflow-hooks/` stub) with the file tools.
  - `policy.mjs` now also denies, with the shell guard's message, a path in `.git/hooks`, `.git/sflow-hooks`, a linked worktree's or a submodule's hooks dir (by name, case-insensitive), and anything inside the repo's real `<git common dir>/hooks`, `<git common dir>/sflow-hooks` or a configured `core.hooksPath` (relative to the work tree, absolute, or `~/`). The path is checked as given and resolved (`..`, `//`, symlinked parents), so a separate git dir or a symlink to `.git/hooks` is covered.
  - Tighten-only: nothing that was denied becomes allowed. Ordinary files named like hooks stay allowed (`src/hooks/`, `hooks/harness/`, `.github/hooks/`, `.githooks/` unless it is `core.hooksPath`).
  - `npm run test:hooks` has must-deny and must-allow cases for all three tools; six mutations of the check are each caught.
  - Review round (CTO, 4 bypasses):
    - Dangling symlinks: a link into a hooks dir is followed to its target even when the target doesn't exist yet, up to 40 hops (`ln -s .git/hooks/post-commit pc`, then `Write pc`).
    - Hardlinks: a file with more than one link that shares dev and inode with a file in a hooks dir is denied (`ln .git/hooks/pre-commit hl`, then `Edit hl`), including `.git/sflow-hooks`.
    - `core.hooksPath` outside the repo: the effective `--global` and `--system` values (absolute, `~/`, or relative to each repo) are protected in every repo, alongside the local one.
    - Fail open: every error path now denies with exit 2 and the JSON deny ("harness hook error (failing closed)"). That covers a missing git binary, a safe.directory refusal, an unparsable or unreadable git config, any other git failure, an unreadable or empty event, a failed module load, and an uncaught exception.
    - `.git/config*`, `.git/info/**`, `.git/worktrees/*/` and `.git/modules/*/` configs, `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and `$GIT_CONFIG_GLOBAL` can't be written through the file tools. Those files can set `core.hooksPath`, aliases or filters.
    - `NotebookEdit` is in the policy matcher, and `notebook_path` is checked.
    - Path comparisons fold case on darwin and win32.
    - The shell guard denies `ln`/`ln -s` from or into a hooks dir, and `chmod`/`chown`/`chgrp` through a link into one.
  - Outside a git repository a normal Write/Edit is allowed; only the global/system hooksPath and global config files are checked there. With no git binary, every file-tool write is denied, even outside a repo. In the shell guard, a git failure falls back to the name check, so shell commands in an unreadable repo behave as before; only hook-dir hits deny.
  - Collateral denies: file-tool writes to `.git/info/exclude` and `.git/info/sparse-checkout`; `chmod +x .git/hooks/<x>` in the shell.
  - Not covered: `~user/` paths in `core.hooksPath`, files pulled in by `include.path`, and the system gitconfig file itself.
  - The review round's own tests (dangling and hard links, global and system hooksPath, every fail-closed path, the shell `ln`/`chmod` cases) are in `npm run test:hooks`. All 16 mutations of the new checks are killed.
- Harness: deleting, moving or un-executing git hooks is denied (SID-155, security; found by sflow Engineer (dogfooding)). On 0.5.0 the Bash guard denied writes into `.git/hooks`, `--no-verify` and `core.hooksPath` overrides, but `rm -rf .git/hooks`, `rm -f .git/hooks/pre-push` and `mv .git/hooks /tmp/x` were allowed, which would turn off the git hooks that SID-147 runs outside Claude. `rm`, `unlink`, `rmdir`, `shred`, `find … -delete|-exec`, `chmod` and the sources of `mv`, aimed at `.git/hooks` (also a submodule's or a linked worktree's, `$(git rev-parse --git-path hooks)`, `$GIT_DIR/hooks`, after `cd .git`), `.git/sflow-hooks` or `.husky`, are now denied; a glob that could match one (`.git/*`, `.gi?/hooks`, `.hu*`) fails closed. Writing into `.git/sflow-hooks` or a linked worktree's hooks dir (overwriting or emptying a stub, e.g. `printf 'exit 0\n' > .git/sflow-hooks/pre-push`) is denied like a write into `.git/hooks`. Reading hooks (`ls`, `cat`, `cp` from) and ordinary removals (`rm -rf build/`, `rm hooks.txt`) stay allowed. Tighten-only: nothing main denied becomes allowed (main 5c959d2 is now a regression baseline; the allowlist is unchanged). Not covered: `rm -rf .git` and writes under `.git/refs` (SID-77); paths held in shell variables, `find .` from above the hooks dir, `chmod --reference`, a wrapped `cp`/`ln` with a trailing word, and `.husky/*` writes (all allowed on main too; SID-161).

**Upstream pins**

`addyosmani/agent-skills` is bumped to upstream 0.6.15 and `mattpocock/skills` to `4ae2317ddb22`; the other six pins are unchanged. The lock goes from 916 files at `v0.5.0` to 922.

| Source | Author | License | Pin |
|---|---|---|---|
| `cursor/plugins/pstack` | Lauren Tan | MIT | unchanged: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `cursor/plugins/cursor-team-kit` | Cursor (Eric Zakariasson) | MIT | unchanged: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `cursor/plugins/thermos` | Cursor | MIT | unchanged: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `mattpocock/skills` | Matt Pocock | MIT | bumped: [`4ae2317ddb22`](https://github.com/mattpocock/skills/commit/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d) (was [`a496f5513d4a`](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa)) |
| `addyosmani/agent-skills` | Addy Osmani | MIT | bumped: [`8bfcc1f9916f`](https://github.com/addyosmani/agent-skills/commit/8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e) (was [`eb07f19f52c2`](https://github.com/addyosmani/agent-skills/commit/eb07f19f52c2669f2364897aaa293e2aaddd7b1c)) |
| `flutter/agent-plugins` | Flutter team | BSD-3-Clause | unchanged: [`90fa51dc9d1b`](https://github.com/flutter/agent-plugins/commit/90fa51dc9d1bd6694cee226397e08ec8193e9e69) |
| `VeryGoodOpenSource/vgv-ai-flutter-plugin` | Very Good Ventures | MIT | unchanged: [`e2231bfbd948`](https://github.com/VeryGoodOpenSource/vgv-ai-flutter-plugin/commit/e2231bfbd94888eab8b179eaed8fa997d09c50bd) |
| `VeryGoodOpenSource/vgv-wingspan` | Very Good Ventures | MIT | unchanged: [`e78608956d26`](https://github.com/VeryGoodOpenSource/vgv-wingspan/commit/e78608956d26777efcda2e6ecefb0a3e981fb115) |

## [0.5.0] - 2026-10-31

Harness security hardening. The policy fails closed and is read only from the base branch on origin (SID-65, #13); the Bash guard normalises git invocations, wrappers, redirections and quoting, and resolves `HEAD`/`@` in pushes (SID-79, SID-80, #16); and the policy files can no longer be written from the shell (SID-66, #15). Breaking for 0.4.0 users of the harness: with no `.harness.json` committed on the base branch on origin, strict defaults apply (`main`, `master` and the remote default branch protected, merges denied, no gate), and an uncommitted or branch-only policy is ignored (see the Migration note under Fixed).

### Fixed

- Harness policy fails closed (SID-65, security). `config()` read `.harness.json` only from `origin/main` and `origin/master` and fell back to the working-tree file, so an agent could write that file and give itself `allowMerge: true`, and a repo whose protected branch is `develop` was not found. The working tree is now never read as policy. The policy is looked up on `origin/HEAD`'s branch, then `main`, then `master`; with none committed, the guard runs with strict defaults (protected: `main`, `master`, the remote default branch; merges denied; no gate; no Stop items). The branch the policy is read from stays protected unless `protectedBranches` is `[]`. Deny messages and the SessionStart context say which policy is in force and how a human adopts one. This corrects the 0.3.0 wording "They activate when a repository has `.harness.json` on its protected branch" (the guard is always on) and "read from origin/<protected>, not the working tree". The gate and Stop use `cfg.base` (the branch the policy came from) instead of `protectedBranches[0]`. [#13](https://github.com/siddhant-angore/sflow/pull/13) (SID-65)
  - Also refused now, because remote-tracking refs locate the policy: `git remote set-head <remote> <branch|-d>` (`--auto`/`-a` stay allowed), `git symbolic-ref` writes or deletes under `refs/remotes/`, `git update-ref` on `refs/remotes/`, and `git fetch`/`git pull` with an explicit refspec whose destination is under `refs/remotes/`. Plain `git fetch`/`git pull` (`--prune`, `--all`, a branch, a local-branch refspec), `set-head --auto`, config reads, and unrelated `-c`/`GIT_CONFIG_*` settings stay allowed; each deny message names the allowed alternative. Also `git config` writes to `remote.<name>.fetch`, including the per-command `-c`/`--config-env` and `GIT_CONFIG_*` env forms (reads stay allowed) and `gh repo edit` (it has its own message; `gh repo view` stays allowed), since both can steer which branch the policy lookup trusts. The `reset --hard` message no longer suggests `git stash`.
  - Ref shadowing: the policy lookup, the `origin/HEAD` target, the gate's merge base and `{base}`, and Stop's ahead count resolve `refs/remotes/origin/<branch>` with `git show-ref --verify` (exact ref, no fallback) and use the resulting sha, so a local tag or branch named `origin/main` or `refs/remotes/origin/<branch>` cannot stand in for the remote ref, whether or not the remote ref exists (this affected main before SID-65 too). A missing remote ref is skipped (fail closed). An `origin/HEAD` that points outside `refs/remotes/origin/`, or at a branch with no remote-tracking ref, is ignored and the lookup falls back to `main`, then `master`.
  - Replace objects: the hooks run every git command with `--no-replace-objects` (and `GIT_NO_REPLACE_OBJECTS=1`, also for gate commands), so a `refs/replace/` entry can't swap the commit or file the policy is read from (main was affected too). The guard now refuses writes to `refs/replace/` (`git update-ref`, `git replace` write forms, `update-ref --stdin` (now denied outright, see below), fetch refspecs into `refs/replace/`); `git replace -l`/`--list` is now allowed (previously denied as history rewriting). `git symbolic-ref HEAD <target>` outside `refs/heads/` is refused (HEAD pointed at origin/main plus a reset rewrote origin/main); reads and `HEAD refs/heads/<b>` stay allowed.
  - Unreadable repository: the guard no longer exits when git can't read the repository (for example after `git config core.bare true`, `core.repositoryformatversion 9`, or a broken `include.path`, which let `git push -f origin HEAD:main` go through and allowed `gh pr merge -R`; main was affected too). It now applies every guard rule with strict defaults (protected `main`, `master`; merges denied), also outside a repository. Writes to `core.bare`, `core.repositoryformatversion`, `core.worktree`, `include.path` and `includeIf.*` (`git config` in any scope, `-c`, `--config-env`, `GIT_CONFIG_*`) are refused; reads stay allowed.
  - Also refused: pushes to `.`/`./` and push destinations under `refs/remotes/` or `refs/replace/`, `git fast-import`, and `git update-ref --stdin` outright (the piped form was allowed in c1b308c when its input named no protected ref; variables and files beat that check, so it is denied now).
  - Branch unknown: a push now has to name its branch whenever the hook can't tell which branch it updates. (a) With no known branch, `git push`, `git push origin`, `-u origin`, `--force-with-lease` without a refspec, and a bare `HEAD` or `@` refspec are denied ("name the branch: git push origin <branch>"); an explicit destination still goes through the protected-branch checks. On a protected branch, `git push origin HEAD`/`@` is now denied too. (b) A command that retargets git (`git -C`, `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`, or a `cd`/`pushd` before the push) counts as branch-unknown, so `git -C <other-repo> push` can no longer ride on the current repo's branch. Leading `VAR=value` words (and `env`) are stripped before rules match, so `GIT_DIR=x git push -f` no longer slips past the push rules. (c) The repo root falls back to the git dir (`rev-parse --absolute-git-dir`) when there is no work tree (cwd inside `.git`, or `core.bare=true`): the branch and the committed policy stay readable; the push gate then asks for a push from the work tree and Stop stays quiet. `core.bare=true` is no longer "unreadable" (a committed policy applies through the git dir); a broken `core.repositoryformatversion` or `include.path` still is. Also: every hook git call runs with `core.fsmonitor=false`; `allowMerge` must be the boolean `true` (`"true"`, `1`, `"false"` deny); in an unreadable repo `gh pr merge`/`gh pr close` say to fix the repo config instead of suggesting `allowMerge`.
  - **Migration:** repos that relied on an uncommitted or branch-only `.harness.json` now get strict defaults (no gate run, merges denied, `main`/`master`/`origin/HEAD` protected) until a human merges the policy into the base branch on origin and runs `git fetch origin`. Repos whose policy is on a non-`main`/`master` default branch are now found (if `origin/HEAD` is set; otherwise run `git remote set-head origin --auto` once). Explicit remote-ref rewrites are now refused.
- Harness guard normalisation (SID-79): global git options (`-P`/`-p`/`--paginate`, `--no-replace-objects`, any option before the subcommand), wrappers (`env [VAR=x]`, `command`, `exec`, `nice`, `nohup`, `time`, `timeout`, `sudo`, `xargs` and similar), a leading `VAR=x`, an absolute or relative path to, or a backslash before, `git`/`gh`/`npm` and the other guarded tools, and subshell and grouping boundaries no longer skip the guard rules (`git -P push --force origin main` and `env git reset --hard` were allowed). Indirection through variables, aliases, `sh -c` and scripts stays best-effort. SID-80: on a protected branch, `git push origin HEAD`, `@`, `-u origin HEAD`, `HEAD:HEAD` and `@:main` are now denied (they pushed the protected branch); on a feature branch they stay allowed; a no-refspec push with a push option argument (`-o x`, `--repo x`) on a protected branch is now denied too. Shell redirections anywhere in the command (before or after the arguments, e.g. `2>&1`, `&>/dev/null`, `>&2`) no longer hide flags, refspecs or a no-refspec push on a protected branch. Command splitting is quote-aware (`$(...)` and backticks inside double quotes, `$'...'` with escapes, heredoc bodies as data, backslash-newline joined, `sh -c -- P` and `-c -x P` payloads, `sh -c`/`eval`/`su -c`/`script -c`/`flock -c`/`watch`/`ssh host` strings checked), but quotes are honoured only when every command in the line is non-executing (`echo`, `grep`, `git commit`, `git log` and similar, without option prefixes that run a value such as `--upl`/`--exe`/`--receive-p`, or option words with `{`, `[`, `*` or `?` that the shell can expand into one) and the line writes no file (text written to a file can run later); otherwise the quoted text is also scanned as before, so `echo 'x; git push -f' | sh` and `git -c core.pager=...` stay denied, as does anything with an unterminated quote or heredoc. Heredoc bodies fed to a shell (`bash <<E`, `ssh host <<E`) are checked as commands. Shell writes (redirections, `tee`, `cp`/`mv`/`ln`/`install`, `sed -i`/`perl -i`, `dd`, `sort -o`, `uniq IN OUT`, `git log`/`diff`/`show --output`) into `.git/config`, `~/.gitconfig` or another git config file, or into a hooks directory, are denied (use `git config`; ask before installing hooks), and writes into `.git/info/` or `.git/modules/` are denied when the same line runs git. A `#` comment is never run, so its text no longer triggers a rule. The `git reset --hard` message no longer suggests `git stash`. [#16](https://github.com/siddhant-angore/sflow/pull/16)
- Harness policy files can no longer be written from the shell (SID-66, security). `policy.mjs` covered only Edit/Write/MultiEdit, so `cat > .harness.json <<'J'`, `echo '{}' > .harness.json` or `cp /dev/null .claude/settings.json` was allowed, and a shell-written `.claude/settings*.json` changes Claude Code's own permissions. `pre-bash.mjs` now refuses, with or without a committed policy, any command that writes, creates, replaces, moves, links or deletes `.harness.json`, `.claude/settings.json` or `.claude/settings.local.json` (any directory, `~` and `$HOME` paths, quoted or globbed names): output redirects and heredocs, `tee`, `cp`/`install`/`rsync`/`ln`/`mv`, `rm`/`unlink`/`truncate`/`shred`, `dd of=`, `sed -i`/`perl -i`/`ruby -i`, `ed`/`ex`/`vim`/`vi`/`nano`/`emacs`, `git checkout`/`restore`/`mv`/`rm` of the file, `sh -c`/`eval` strings, and `node -e`/`python -c`/`ruby -e`/`perl -e`/`deno eval`/`bun -e` one-liners that call a write or delete. Reading, `git add`/`diff`/`log`/`show`, `git rm --cached`, `git restore --staged`, copying a policy file to another file name, and ordinary files such as `settings.json` outside `.claude/` stay allowed. A write through an existing symlink to a policy file is refused too. So are whole-directory operations on a directory named `.claude` (any parent, `~`, `$HOME`): `rm -r`/`-rf`/`-R`/`--recursive`, `mv` with it as source or destination, `cp`/`rsync`/`ln` onto it when a source is also named `.claude`, `git checkout <ref> -- .claude`, `git restore .claude` (not `--staged` alone), `git rm -r .claude` (not `--cached`); `rm -rf .claude/commands`, `mkdir -p .claude/agents` and `cp x.md .claude/commands/` stay allowed. Copying FROM a policy file is a read and stays allowed (`cp .harness.json backup/`, `cp .harness.json /tmp/`, `cp .harness.json sub`, `cp -t sub .harness.json`, `rsync`/`install` the same, `cp .claude/settings.json /tmp/`). A copy is refused only when its destination is an explicit policy-named path (`cp a .harness.json`, `cp a sub/.harness.json`, `cp a .claude/settings.json`), the `.claude` directory with a settings-named source (`cp x/settings.json .claude`), or a directory (trailing slash, `.`, `..`, `-t`, or an existing one) where `<dir>/<source name>` resolves, against the command's working directory and any `cd` earlier in it, to the repo-root `.harness.json` or a `.claude/settings*.json` (`cp sub/.harness.json .`, or `cp ../x/.harness.json ..` run from `sub`). `mv` of a policy file stays refused because it removes the policy, and so do `ln` with a policy path, `rm .*` and `mv .* x/`. Interpreter one-liners are refused only when the script names a policy file and calls a write or delete (a copy counts only through its destination); `node -e` with `readFileSync`, `python -c` with `json.load(open(...))` or `read_text`, and Ruby `File.open(f)` stay allowed. When git can't read the repository (SID-65's strict defaults), these rules still apply and the working directory stands in for the repo root. Each deny message says what to do instead, and the Edit/Write deny message does as well. The check is best-effort; the backstop is SID-65, where only the base branch on origin is policy. The first `.harness.json` is documented: the agent drafts the JSON in its PR description and a human commits and merges it. Not closed: variable or indirect paths, scripts written to a file then run, `git apply`/`patch`, and branch switches that change a tracked `.claude/settings.json`. [#15](https://github.com/siddhant-angore/sflow/pull/15)
  - Round 3 (CTO review): wrappers (`nice -n 5`, `sudo -u root`, `timeout 5`, `stdbuf -o0`, `ionice`, `flock <lock>` incl. `flock <lock> -c '...'`, `setsid`, nested) are peeled through the shared `unwrap` helper in `lib.mjs`, so a wrapper option's value no longer hides the command; `<>` counts as a write; a `cd` earlier in the command applies to redirects, `tee`, `sed -i` and the rest (`cd .claude && echo > settings.json`); `sed -i` and `perl`/`ruby -i` targets go through the symlink check; interpreter one-liners are denied only when the policy path is the write target (or a variable holding it), so reading `.harness.json` and writing `/tmp` is fine.

**Upstream pins**

Unchanged from 0.4.0: all eight source keys are at the same commits, and the lock holds 916 files.

| Source | Author | License | Pin |
|---|---|---|---|
| `cursor/plugins/pstack` | Lauren Tan | MIT | unchanged: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `cursor/plugins/cursor-team-kit` | Cursor (Eric Zakariasson) | MIT | unchanged: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `cursor/plugins/thermos` | Cursor | MIT | unchanged: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `mattpocock/skills` | Matt Pocock | MIT | unchanged: [`a496f5513d4a`](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) |
| `addyosmani/agent-skills` | Addy Osmani | MIT | unchanged: [`eb07f19f52c2`](https://github.com/addyosmani/agent-skills/commit/eb07f19f52c2669f2364897aaa293e2aaddd7b1c) |
| `flutter/agent-plugins` | Flutter team | BSD-3-Clause | unchanged: [`90fa51dc9d1b`](https://github.com/flutter/agent-plugins/commit/90fa51dc9d1bd6694cee226397e08ec8193e9e69) |
| `VeryGoodOpenSource/vgv-ai-flutter-plugin` | Very Good Ventures | MIT | unchanged: [`e2231bfbd948`](https://github.com/VeryGoodOpenSource/vgv-ai-flutter-plugin/commit/e2231bfbd94888eab8b179eaed8fa997d09c50bd) |
| `VeryGoodOpenSource/vgv-wingspan` | Very Good Ventures | MIT | unchanged: [`e78608956d26`](https://github.com/VeryGoodOpenSource/vgv-wingspan/commit/e78608956d26777efcda2e6ecefb0a3e981fb115) |

## [0.4.0] - 2026-10-31

pstack from Lauren Tan's original in `cursor/plugins` with the agentic Orchestrate rewrite, per-source and per-pack licenses, upstream drift checks, CI, and offline tests for the vendoring scripts. Breaking for 0.3.0 users: model-invocable skills drop from 108 to 48, the `babysit` skill and `skills/poteto-mode/scripts/orch/` are removed, and Orchestrate works differently (see Changed and Removed).

### Added

- This changelog [#5](https://github.com/siddhant-angore/sflow/pull/5) (SID-48).
- CI (`.github/workflows/ci.yml`) on every PR and push to `main`: a tracked-symlink gate, `npm run check` (vendor hashes, plugin validate, hooks, routing), and a vendor drift job (`vendor.mjs sync` must leave the tree clean). Actions are SHA-pinned; no secrets; `eval:brake` stays manual. [#2](https://github.com/siddhant-angore/sflow/pull/2) (SID-42), merged in `a216f9b`.
- `docs/adr/0001-pstack-source-of-truth.md`, the decision record for taking pstack from the original. [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44).
- `npm run test:eval-brake` (`scripts/test-eval-brake.mjs`): offline tests plus end-to-end tests that run `eval-brake` against a fake `claude` on `PATH`. Part of `npm run check`. [#6](https://github.com/siddhant-angore/sflow/pull/6) (SID-47).
- Upstream drift check, `npm run upstream` (`scripts/upstream.mjs`): read-only, no token. It compares every pinned `sha` with the upstream default branch, counts only commits that touch the vendored paths or the source's licence file, lists changed files, new or removed skill directories and overlays whose anchored file changed, and exits `0` (current or held), `10` (behind) or `1` (error). `--json` gives a machine-readable report. An optional `"hold": "<reason>"` on a source in `vendor.manifest.json` defers it without exit `10`. `.github/workflows/upstream.yml` runs it weekly (Monday 03:30 UTC) and on demand, and opens, updates or closes one `upstream-drift` issue; it never opens a PR or merges. `npm run test:upstream` (`scripts/test-upstream.mjs`) covers it offline, including one real-git test over `file://`, and is part of `npm run check`. [#4](https://github.com/siddhant-angore/sflow/pull/4) (SID-50).
- `npm run test:vendor` (`scripts/test-vendor.mjs`): offline tests for `scripts/vendor.mjs` sync and check against local fixture upstreams over `file://` (symlink resolution, escapes, loops and broken links, rename, include and exclude, per-source licences, collisions, stale overlay anchors, the check reports, and a failed sync leaving the tree untouched; orphan `LICENSES` pruning; pack licenses and `NOTICE.md` copied, orphan pack licenses pruned, a stale or missing pack license, `NOTICE.md` or `LICENSE` and an altered MIT grant failing check, and sync repairing a stale pack), and for `scripts/check-versions.mjs`, which fails `npm run check` unless the four version fields (`plugin.json`, both `marketplace.json` entries, `domains/flutter/.claude-plugin/plugin.json`) agree, including when run through a symlink or a path with a space. Both are part of `npm run check`. [#11](https://github.com/siddhant-angore/sflow/pull/11) (SID-51)

### Changed

- pstack is vendored from Lauren Tan's original in `cursor/plugins` (Claude Code build in `harness/pstack/claude-code/`), replacing the `michael-denyer/pstack-claude` port. It was first pinned to `9f844cd`, the commit before the Orchestrate rewrite `c742dd6`; the next bullet moves the pin past it (SID-43). The six team-kit skills and the thermos skills and subagents now come from `cursor/plugins/cursor-team-kit` and `cursor/plugins/thermos` at the same commit. [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44), merged in `d5affba`.
  - Licenses are per source (`licensePath`), copied into `LICENSES/cursor__plugins__*.LICENSE`, and the `NOTICE.md` header is generated from the manifest.
  - Routing follows upstream: **108 → 48 model-invocable skills**. Upstream marks pstack's router, principle and playbook skills (and the thermos skills) `disable-model-invocation: true`, so the model reads them by path. Slash commands still work.
  - Upstream pins: `cursor/plugins` added at [`9f844cdaac06`](https://github.com/cursor/plugins/commit/9f844cdaac06aeaa1b2d17fbcb57e078979c6f99) (three source keys: `pstack`, `cursor-team-kit`, `thermos`), then bumped to `4dd1d05818d1` (see the next bullet); `michael-denyer/pstack-claude` removed; the other five pins are unchanged. The lock held 919 files at `9f844cd`, 916 files after SID-43.
- SessionStart hook: the port's mandate (`hooks/session-start.sh` and its context files, which told the agent to invoke `pstack:poteto-mode`) is replaced by an sflow-authored `hooks/harness/session-start.mjs`, built from `workflows/hooks/`. It tells the agent to invoke the `sflow:sflow` router skill when a task touches more than one file, involves a design choice, or is a bug of unknown cause or a performance issue, and to work directly on smaller changes. It also says to read the pstack skills the Skill tool refuses with the Read tool, and that user instructions take precedence. It fails open: any error exits 0 with no output. [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44).
- pstack bumped to `cursor/plugins` [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) (all three `cursor/plugins` keys; `cursor-team-kit` and `thermos` are unchanged in content). It includes `c742dd6`: Orchestrate is agentic (`Task` workers, Project tracker and store, PR and CI event subscriptions). The `workflows/program.md` overlay is re-anchored on the new sentence about keeping the program's state in the Project tracker and store. [#9](https://github.com/siddhant-angore/sflow/pull/9) (SID-43)
- Review follow-ups for #4 and #6: the upstream-drift workflow runs the network check once per attempt and reuses its `--json` report, and its close comment lists each held source with its status and flags stale holds; `eval:brake` rejects a repeated `--runs`/`--model` (exit 2), names an `ENOBUFS` failure and raises `maxBuffer` to 64 MiB; the CI comment lists every test `check.mjs` runs. [#8](https://github.com/siddhant-angore/sflow/pull/8) (SID-56).
- `scripts/vendor.mjs` sync builds in a staging copy and swaps the outputs in only on success, so a failed fetch, copy or overlay no longer leaves vendored targets half-deleted. Symlink loops and broken upstream links now fail with a clear error naming the source and link, and `check` reports an unlocked symlink once, as `symlink:`, not also as `unexpected`. [#11](https://github.com/siddhant-angore/sflow/pull/11) (SID-51)
- SID-51 follow-ups after merging SID-46 and SID-63: the staged sync now copies each pack's `LICENSES/` and `NOTICE.md` back too (before, a sync never wrote them to the real tree), and `scripts/check-versions.mjs` detects that it is the main script through a symlink or a path with a space, where it used to exit 0 without checking. [#11](https://github.com/siddhant-angore/sflow/pull/11) (SID-51)

### Removed

- The port-only pieces with no upstream equivalent: the `babysit` skill (covered by the Babysit playbook in `poteto-mode`), `models.json` and `pi/`, the port's icon (`assets/pstack-icon.png` and `assets/pstack-icon.prompt.txt`), and the port's hooks (Codex/Copilot/Muse adapters, awk/PowerShell helpers, `pre-tool-use.*`, the SessionStart mandate). [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44).
- `skills/poteto-mode/scripts/orch/` (`orch.ts`, `store.ts`, `orch.test.ts`; about 3k lines of Bun/TS), deleted upstream in `c742dd6`. [#9](https://github.com/siddhant-angore/sflow/pull/9) (SID-43)

### Fixed

- `vendor.mjs` now materializes upstream symlinks. 29 Flutter wingspan files were dangling absolute symlinks into a macOS temp directory, so `npm run check` failed on a fresh clone. `npm run check` now rejects vendored symlinks. It makes no pin change. [#1](https://github.com/siddhant-angore/sflow/pull/1) (SID-41), merged in `7bda5c0`.
- `npm run eval:brake` no longer crashes with a raw buffer dump when `claude -p` exits non-zero. It prints a readable reason and exits 0 (brake held), 1 (brake failed) or 2 (harness/CLI error). A transient CLI error is retried once (the 600 s kill is not); `--runs N` repeats the eval (capped at 5), and a bare `--runs` or `--model` is a usage error (exit 2); scratch repos are removed after a pass and kept after a failure. [#6](https://github.com/siddhant-angore/sflow/pull/6) (SID-47), merged in `576f147`.
- Credits and licenses (SID-46): `LICENSE`, `README.md` and `domains/flutter/README.md` now credit every vendored author (Lauren Tan, Cursor, Matt Pocock, Addy Osmani, Very Good Ventures, The Flutter Authors), and the `NOTICE.md` header states the license breakdown (7 MIT, 1 BSD-3-Clause). `vendor.mjs sync` rebuilds `LICENSES/` from the manifest and removes files no source owns, which deletes the orphan `LICENSES/flutter__skills.LICENSE`. `vendor.mjs check` now fails on a source with no license file (`missing license`), a license file with no source (`orphan license`), and a stale `NOTICE.md` header. [#10](https://github.com/siddhant-angore/sflow/pull/10) (SID-46).
- `sflow-flutter` now ships its own licenses. It is installed from `domains/flutter/` alone, so it had no license text or attribution for the BSD-3-Clause and MIT work it vendors. `vendor.mjs sync` copies the three sources' licenses into `domains/flutter/LICENSES/` and writes `domains/flutter/NOTICE.md`; `domains/flutter/LICENSE` covers sflow's own files in the pack; `vendor.mjs check` fails on a missing, orphan or stale pack license or NOTICE. [#12](https://github.com/siddhant-angore/sflow/pull/12) (SID-63)

**Upstream pins**

`michael-denyer/pstack-claude` is replaced by three `cursor/plugins` source keys at one commit; the other five pins are unchanged. The lock went from 975 files at `v0.3.0` to 916.

| Source | Author | License | Pin |
|---|---|---|---|
| `michael-denyer/pstack-claude` | Lauren Tan's pstack, Claude Code port by Michael Denyer | MIT | removed (was [`22b5e137e945`](https://github.com/michael-denyer/pstack-claude/commit/22b5e137e945cb65dd29dac5fc703c13d83a00aa)) |
| `cursor/plugins/pstack` | Lauren Tan | MIT | added: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `cursor/plugins/cursor-team-kit` | Cursor (Eric Zakariasson) | MIT | added: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `cursor/plugins/thermos` | Cursor | MIT | added: [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) |
| `mattpocock/skills` | Matt Pocock | MIT | unchanged: [`a496f5513d4a`](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) |
| `addyosmani/agent-skills` | Addy Osmani | MIT | unchanged: [`eb07f19f52c2`](https://github.com/addyosmani/agent-skills/commit/eb07f19f52c2669f2364897aaa293e2aaddd7b1c) |
| `flutter/agent-plugins` | Flutter team | BSD-3-Clause | unchanged: [`90fa51dc9d1b`](https://github.com/flutter/agent-plugins/commit/90fa51dc9d1bd6694cee226397e08ec8193e9e69) |
| `VeryGoodOpenSource/vgv-ai-flutter-plugin` | Very Good Ventures | MIT | unchanged: [`e2231bfbd948`](https://github.com/VeryGoodOpenSource/vgv-ai-flutter-plugin/commit/e2231bfbd94888eab8b179eaed8fa997d09c50bd) |
| `VeryGoodOpenSource/vgv-wingspan` | Very Good Ventures | MIT | unchanged: [`e78608956d26`](https://github.com/VeryGoodOpenSource/vgv-wingspan/commit/e78608956d26777efcda2e6ecefb0a3e981fb115) |

Notable upstream changes: `cursor/plugins` `c742dd6` rewrote Orchestrate (agentic `Task` workers, Project tracker and store, PR and CI event subscriptions) and deleted `scripts/orch/`.

## [0.3.0] - 2026-10-30

Harness hooks, a loop brake, and a behavioral eval. Tag `v0.3.0` points at `5cf8fff`.

### Added

- Harness hooks in `hooks/harness/` (`guard-rules.mjs`, `lib.mjs`, `policy.mjs`, `pre-bash.mjs`, `stop.mjs`), built from `workflows/hooks/` and registered in `hooks/hooks.json`. They activate when a repository has `.harness.json` on its protected branch. Hooks fail closed.
  - Guard: blocks force and `+` pushes, pushes to a protected branch, `reset --hard`, `clean -f`, `branch -D`, history rewrites, `--no-verify`, `gh pr merge`, GitHub write API calls, releases, and publishes.
  - Policy: `.harness.json` and `.claude/settings.json` are read-only to the agent. The policy is read from `origin/<protected>`, not the working tree.
  - Gate: `git push` and `gh pr create` run the `gate` commands first, skip when HEAD already passed, and scan the pushed range for secret-shaped text.
  - Stop (loop brake): unmet definition-of-done items block the turn once per repo state. After three non-converging attempts on the same unmet items, the hook demands an auditable failure report and then lets the turn end.
- Run record: gate results and Stop decisions are appended to `<git dir>/harness/runs.jsonl`. The Retro playbook reads it first.
- `templates/harness.json`, a starter `.harness.json`.
- `npm run test:hooks` (`scripts/test-hooks.mjs`).
- `npm run eval:brake` (`scripts/eval-brake.mjs`), a behavioral eval: a live model in a scratch repo with a failing gate must neither push nor claim the push succeeded. It costs one short headless model run.
- "Harness hooks" section in `README.md`.

### Changed

- Overlay edits: sensors before judges in the Opening a PR playbook, specs are committed in the Spec playbook, MCP authoring points at the 2026-07-28 revision (Setup playbook), the Retro playbook reads the run record first, and the sflow entry skill gains a symptom-to-layer table. The Flutter pack's Retro overlay was updated to match.
- `scripts/build-workflows.mjs` builds the hook files; `scripts/check.mjs` was extended (one line).
- Plugin version bumped 0.2.0 → 0.3.0 in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both plugin entries), and `domains/flutter/.claude-plugin/plugin.json`. All three agree at this tag.

**Upstream pins**

No pin changed. The lock grew from 970 to 975 files; the five new entries are the `hooks/harness/*.mjs` files above, and `hooks/hooks.json` and a few playbook files changed hash because of the overlays. No vendored upstream file changed.

| Source | Author | License | Pin |
|---|---|---|---|
| `michael-denyer/pstack-claude` | Lauren Tan's pstack, Claude Code port by Michael Denyer | MIT | unchanged: [`22b5e137e945`](https://github.com/michael-denyer/pstack-claude/commit/22b5e137e945cb65dd29dac5fc703c13d83a00aa) |
| `mattpocock/skills` | Matt Pocock | MIT | unchanged: [`a496f5513d4a`](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) |
| `addyosmani/agent-skills` | Addy Osmani | MIT | unchanged: [`eb07f19f52c2`](https://github.com/addyosmani/agent-skills/commit/eb07f19f52c2669f2364897aaa293e2aaddd7b1c) |
| `flutter/agent-plugins` | Flutter team | BSD-3-Clause | unchanged: [`90fa51dc9d1b`](https://github.com/flutter/agent-plugins/commit/90fa51dc9d1bd6694cee226397e08ec8193e9e69) |
| `VeryGoodOpenSource/vgv-ai-flutter-plugin` | Very Good Ventures | MIT | unchanged: [`e2231bfbd948`](https://github.com/VeryGoodOpenSource/vgv-ai-flutter-plugin/commit/e2231bfbd94888eab8b179eaed8fa997d09c50bd) |
| `VeryGoodOpenSource/vgv-wingspan` | Very Good Ventures | MIT | unchanged: [`e78608956d26`](https://github.com/VeryGoodOpenSource/vgv-wingspan/commit/e78608956d26777efcda2e6ecefb0a3e981fb115) |

Notable upstream changes: none.

## [0.2.0] - 2026-10-30

Flutter domain pack. Tag `v0.2.0` points at `8f00181`.

### Added

- `sflow-flutter`, a second plugin in the same marketplace (`domains/flutter/`). Install with `/plugin install sflow-flutter@sflow`. The core router applies it when the repository matches (a `pubspec.yaml`).
  - Per the commit message: the Flutter team's 25 skills and hot-reload rule; Very Good Ventures' 15 skills, 11 agents, and hooks (format and analyze after every Dart edit, CLI-workaround blocking); wingspan's skills and agents. This changelog did not recount them.
  - MCP servers: the Dart MCP server (`cli` and `flutter_app_lifecycle` categories enabled) and `very_good mcp`.
- Nine per-playbook overlays (Bug fix, Feature, Investigation, Opening a PR, Perf issue, Refactoring, Retro, Setup, Spec) that name the Flutter skill or MCP tool at each quoted step. Domain overlays are checked against the core playbooks on sync.
- A `flutter` entry skill carrying the house standard (VGV conventions, Flutter-team mechanics) and the hot-reload rule, because Claude Code does not load rules from `rules/`.
- A domain-pack rule in the core router, `domains/flutter/README.md`, an `LICENSES/` file per new source, and new `NOTICE.md` and `docs/skill-map.md` entries.
- `README.md` documents domain packs.

### Changed

- Flutter state standard is Bloc. Mocking: `mocktail` by default (no codegen); `mockito` generated mocks where a package already runs `build_runner` and the interface is large. One discipline for both: `thenAnswer` for async, mocks at boundaries only, `MockBloc` for blocs, never both libraries in one package.
- `scripts/vendor.mjs` dereferences wingspan's `shared` references on vendoring; they are no longer vendored as a separate `wingspan-shared` skill directory.

**Known issues**

- **Version mismatch.** The `v0.2.0` tag does not contain the 0.2.0 version bump. At the tag, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both plugin entries), and `domains/flutter/.claude-plugin/plugin.json` still say `0.1.0`, so a `v0.2.0` checkout reports itself as 0.1.0. The bump is commit `2746be6` (`chore: version 0.2.0`), made 16 seconds after the tag was created (tag 15:33:21, commit 15:33:37 IST), and it is not in the tag. The tag was not moved. `v0.3.0` and later have consistent versions.

**Upstream pins**

Three pins are unchanged from 0.1.0. Three sources are new. The lock grew from 776 to 970 files.

| Source | Author | License | Pin |
|---|---|---|---|
| `michael-denyer/pstack-claude` | Lauren Tan's pstack, Claude Code port by Michael Denyer | MIT | unchanged: [`22b5e137e945`](https://github.com/michael-denyer/pstack-claude/commit/22b5e137e945cb65dd29dac5fc703c13d83a00aa) |
| `mattpocock/skills` | Matt Pocock | MIT | unchanged: [`a496f5513d4a`](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) |
| `addyosmani/agent-skills` | Addy Osmani | MIT | unchanged: [`eb07f19f52c2`](https://github.com/addyosmani/agent-skills/commit/eb07f19f52c2669f2364897aaa293e2aaddd7b1c) |
| `flutter/agent-plugins` | Flutter team | BSD-3-Clause | added: [`90fa51dc9d1b`](https://github.com/flutter/agent-plugins/commit/90fa51dc9d1bd6694cee226397e08ec8193e9e69) |
| `VeryGoodOpenSource/vgv-ai-flutter-plugin` | Very Good Ventures | MIT | added: [`e2231bfbd948`](https://github.com/VeryGoodOpenSource/vgv-ai-flutter-plugin/commit/e2231bfbd94888eab8b179eaed8fa997d09c50bd) |
| `VeryGoodOpenSource/vgv-wingspan` | Very Good Ventures | MIT | added: [`e78608956d26`](https://github.com/VeryGoodOpenSource/vgv-wingspan/commit/e78608956d26777efcda2e6ecefb0a3e981fb115) |

Notable upstream changes: initial pin for the three added sources; none for the unchanged ones.

## [0.1.0] - 2026-10-30

Initial release. Tag `v0.1.0` points at `a83b213`, which includes the initial import `42726ec`.

### Added

- sflow, one workflow plugin that merges three MIT-licensed skill sets under one namespace, vendored by commit with a hash lock (`vendor.lock.json`, 776 files at the tag):
  - pstack (Lauren Tan, Claude Code port by Michael Denyer): the `poteto-mode` router, principles, playbooks, multi-model review, verification discipline.
  - Matt Pocock's skills: all 38, with the `tdd` and `teach` name collisions renamed to `tdd-vertical-slices` and `teach-workspace`.
  - Addy Osmani's agent-skills: all 25, with references, checklists, and review personas.
- Overlays in `workflows/`, merged into pstack's playbooks at build time so each task reads one playbook that carries the sflow steps. A stale overlay anchor fails the build.
- Five new playbooks (Spec, Triage, Retro, Setup, Writing), registered in the router.
- The sflow entry skill, review personas, checklists, and `docs/skill-map.md`, which places every skill (130 per the README at the tag).
- `npm run sync`, `npm run check`, and `npm run routing`.

### Fixed

- The authored sflow skill is now installed at build time. The sync wipes `skills/` before vendoring, so an authored skill there was lost; authored skills now live under `workflows/<name>/` and the build copies them in. (`a83b213`)

**Upstream pins**

Initial pin of all three sources.

| Source | Author | License | Pin |
|---|---|---|---|
| `michael-denyer/pstack-claude` | Lauren Tan's pstack, Claude Code port by Michael Denyer | MIT | added: [`22b5e137e945`](https://github.com/michael-denyer/pstack-claude/commit/22b5e137e945cb65dd29dac5fc703c13d83a00aa) |
| `mattpocock/skills` | Matt Pocock | MIT | added: [`a496f5513d4a`](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) |
| `addyosmani/agent-skills` | Addy Osmani | MIT | added: [`eb07f19f52c2`](https://github.com/addyosmani/agent-skills/commit/eb07f19f52c2669f2364897aaa293e2aaddd7b1c) |

Notable upstream changes: initial pin.

[Unreleased]: https://github.com/siddhant-angore/sflow/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/siddhant-angore/sflow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/siddhant-angore/sflow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/siddhant-angore/sflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/siddhant-angore/sflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/siddhant-angore/sflow/releases/tag/v0.1.0
