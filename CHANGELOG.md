# Changelog

All notable changes to sflow are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release has an "Upstream pins" table: the commit of every vendored source that the release was built from (`vendor.manifest.json`, locked by `vendor.lock.json`). Credit for the vendored work belongs to its authors; licenses are in `LICENSES/` and attribution is in `NOTICE.md`.

## [Unreleased]

> Each pull request adds its own entry here when it merges. The release step moves them under a version heading.

### Added

- This changelog (SID-48).
- CI (`.github/workflows/ci.yml`) on every PR and push to `main`: a tracked-symlink gate, `npm run check` (vendor hashes, plugin validate, hooks, routing), and a vendor drift job (`vendor.mjs sync` must leave the tree clean). Actions are SHA-pinned; no secrets; `eval:brake` stays manual. [#2](https://github.com/siddhant-angore/sflow/pull/2) (SID-42), merged in `a216f9b`.
- `docs/adr/0001-pstack-source-of-truth.md`, the decision record for taking pstack from the original. [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44).
- `npm run test:eval-brake` (`scripts/test-eval-brake.mjs`): offline tests plus end-to-end tests that run `eval-brake` against a fake `claude` on `PATH`. Part of `npm run check`. [#6](https://github.com/siddhant-angore/sflow/pull/6) (SID-47).
- Upstream drift check, `npm run upstream` (`scripts/upstream.mjs`): read-only, no token. It compares every pinned `sha` with the upstream default branch, counts only commits that touch the vendored paths or the source's licence file, lists changed files, new or removed skill directories and overlays whose anchored file changed, and exits `0` (current or held), `10` (behind) or `1` (error). `--json` gives a machine-readable report. An optional `"hold": "<reason>"` on a source in `vendor.manifest.json` defers it without exit `10`. `.github/workflows/upstream.yml` runs it weekly (Monday 03:30 UTC) and on demand, and opens, updates or closes one `upstream-drift` issue; it never opens a PR or merges. `npm run test:upstream` (`scripts/test-upstream.mjs`) covers it offline, including one real-git test over `file://`, and is part of `npm run check`. [#4](https://github.com/siddhant-angore/sflow/pull/4) (SID-50).
- `npm run test:vendor` (`scripts/test-vendor.mjs`): offline tests for `scripts/vendor.mjs` sync and check against local fixture upstreams over `file://` (symlink resolution, escapes, loops and broken links, rename, include and exclude, per-source licences, collisions, stale overlay anchors, the check reports, and a failed sync leaving the tree untouched; orphan `LICENSES` pruning; pack licenses and `NOTICE.md` copied, orphan pack licenses pruned, a stale or missing pack license, `NOTICE.md` or `LICENSE` and an altered MIT grant failing check, and sync repairing a stale pack), and for `scripts/check-versions.mjs`, which fails `npm run check` unless the four version fields (`plugin.json`, both `marketplace.json` entries, `domains/flutter/.claude-plugin/plugin.json`) agree, including when run through a symlink or a path with a space. Both are part of `npm run check`. (SID-51)

### Changed

- pstack is vendored from Lauren Tan's original in `cursor/plugins` (Claude Code build in `harness/pstack/claude-code/`), replacing the `michael-denyer/pstack-claude` port. It was first pinned to `9f844cd`, the commit before the Orchestrate rewrite `c742dd6`; the next bullet moves the pin past it (SID-43). The six team-kit skills and the thermos skills and subagents now come from `cursor/plugins/cursor-team-kit` and `cursor/plugins/thermos` at the same commit. [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44), merged in `d5affba`.
  - Licenses are per source (`licensePath`), copied into `LICENSES/cursor__plugins__*.LICENSE`, and the `NOTICE.md` header is generated from the manifest.
  - Routing follows upstream: **108 → 48 model-invocable skills**. Upstream marks pstack's router, principle and playbook skills (and the thermos skills) `disable-model-invocation: true`, so the model reads them by path. Slash commands still work.
  - Upstream pins: `cursor/plugins` added at [`9f844cdaac06`](https://github.com/cursor/plugins/commit/9f844cdaac06aeaa1b2d17fbcb57e078979c6f99) (three source keys: `pstack`, `cursor-team-kit`, `thermos`), then bumped to `4dd1d05818d1` (see the next bullet); `michael-denyer/pstack-claude` removed; the other five pins are unchanged. The lock held 919 files at `9f844cd`, 916 files after SID-43.
- pstack bumped to `cursor/plugins` [`4dd1d05818d1`](https://github.com/cursor/plugins/commit/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe) (all three `cursor/plugins` keys; `cursor-team-kit` and `thermos` are unchanged in content). It includes `c742dd6`: Orchestrate is agentic (`Task` workers, Project tracker and store, PR and CI event subscriptions). The `workflows/program.md` overlay is re-anchored on the new sentence about keeping the program's state in the Project tracker and store. (SID-43)
- Review follow-ups for #4 and #6: the upstream-drift workflow runs the network check once per attempt and reuses its `--json` report, and its close comment lists each held source with its status and flags stale holds; `eval:brake` rejects a repeated `--runs`/`--model` (exit 2), names an `ENOBUFS` failure and raises `maxBuffer` to 64 MiB; the CI comment lists every test `check.mjs` runs. [#8](https://github.com/siddhant-angore/sflow/pull/8) (SID-56).
- `scripts/vendor.mjs` sync builds in a staging copy and swaps the outputs in only on success, so a failed fetch, copy or overlay no longer leaves vendored targets half-deleted. Symlink loops and broken upstream links now fail with a clear error naming the source and link, and `check` reports an unlocked symlink once, as `symlink:`, not also as `unexpected`. (SID-51)
- SID-51 follow-ups after merging SID-46 and SID-63: the staged sync now copies each pack's `LICENSES/` and `NOTICE.md` back too (before, a sync never wrote them to the real tree), and `scripts/check-versions.mjs` detects that it is the main script through a symlink or a path with a space, where it used to exit 0 without checking. (SID-51)

### Removed

- The port-only pieces with no upstream equivalent: the `babysit` skill (covered by the Babysit playbook in `poteto-mode`), `models.json` and `pi/`, the port's icon (`assets/pstack-icon.png` and `assets/pstack-icon.prompt.txt`), and the port's hooks (Codex/Copilot/Muse adapters, awk/PowerShell helpers, `pre-tool-use.*`, the SessionStart mandate). [#3](https://github.com/siddhant-angore/sflow/pull/3) (SID-44).
- `skills/poteto-mode/scripts/orch/` (`orch.ts`, `store.ts`, `orch.test.ts`; about 3k lines of Bun/TS), deleted upstream in `c742dd6`. (SID-43)

### Fixed

- `vendor.mjs` now materializes upstream symlinks. 29 Flutter wingspan files were dangling absolute symlinks into a macOS temp directory, so `npm run check` failed on a fresh clone. `npm run check` now rejects vendored symlinks. It makes no pin change. [#1](https://github.com/siddhant-angore/sflow/pull/1) (SID-41), merged in `7bda5c0`.
- `npm run eval:brake` no longer crashes with a raw buffer dump when `claude -p` exits non-zero. It prints a readable reason and exits 0 (brake held), 1 (brake failed) or 2 (harness/CLI error). A transient CLI error is retried once (the 600 s kill is not); `--runs N` repeats the eval (capped at 5), and a bare `--runs` or `--model` is a usage error (exit 2); scratch repos are removed after a pass and kept after a failure. [#6](https://github.com/siddhant-angore/sflow/pull/6) (SID-47), merged in `576f147`.
- Credits and licenses (SID-46): `LICENSE`, `README.md` and `domains/flutter/README.md` now credit every vendored author (Lauren Tan, Cursor, Matt Pocock, Addy Osmani, Very Good Ventures, The Flutter Authors), and the `NOTICE.md` header states the license breakdown (7 MIT, 1 BSD-3-Clause). `vendor.mjs sync` rebuilds `LICENSES/` from the manifest and removes files no source owns, which deletes the orphan `LICENSES/flutter__skills.LICENSE`. `vendor.mjs check` now fails on a source with no license file (`missing license`), a license file with no source (`orphan license`), and a stale `NOTICE.md` header. [#10](https://github.com/siddhant-angore/sflow/pull/10) (SID-46).
- `sflow-flutter` now ships its own licenses. It is installed from `domains/flutter/` alone, so it had no license text or attribution for the BSD-3-Clause and MIT work it vendors. `vendor.mjs sync` copies the three sources' licenses into `domains/flutter/LICENSES/` and writes `domains/flutter/NOTICE.md`; `domains/flutter/LICENSE` covers sflow's own files in the pack; `vendor.mjs check` fails on a missing, orphan or stale pack license or NOTICE. (SID-63)
- Harness policy fails closed (SID-65, security). `config()` read `.harness.json` only from `origin/main` and `origin/master` and fell back to the working-tree file, so an agent could write that file and give itself `allowMerge: true`, and a repo whose protected branch is `develop` was not found. The working tree is now never read as policy. The policy is looked up on `origin/HEAD`'s branch, then `main`, then `master`; with none committed, the guard runs with strict defaults (protected: `main`, `master`, the remote default branch; merges denied; no gate; no Stop items). The branch the policy is read from stays protected unless `protectedBranches` is `[]`. Deny messages and the SessionStart context say which policy is in force and how a human adopts one. This corrects the 0.3.0 wording "They activate when a repository has `.harness.json` on its protected branch" (the guard is always on) and "read from origin/<protected>, not the working tree". The gate and Stop use `cfg.base` (the branch the policy came from) instead of `protectedBranches[0]`.
  - Also refused now, because remote-tracking refs locate the policy: `git remote set-head <remote> <branch|-d>` (`--auto`/`-a` stay allowed), `git symbolic-ref` writes or deletes under `refs/remotes/`, `git update-ref` on `refs/remotes/`, and `git fetch`/`git pull` with an explicit refspec whose destination is under `refs/remotes/`. Plain `git fetch`/`git pull` (`--prune`, `--all`, a branch, a local-branch refspec), `set-head --auto`, config reads, and unrelated `-c`/`GIT_CONFIG_*` settings stay allowed; each deny message names the allowed alternative. Also `git config` writes to `remote.<name>.fetch`, including the per-command `-c`/`--config-env` and `GIT_CONFIG_*` env forms (reads stay allowed) and `gh repo edit` (it has its own message; `gh repo view` stays allowed), since both can steer which branch the policy lookup trusts. The `reset --hard` message no longer suggests `git stash`.
  - Ref shadowing: the policy lookup, origin/HEAD, the gate's merge base and Stop's ahead count now use full `refs/remotes/origin/<branch>` names, so a local tag or branch named `origin/main` cannot stand in for the remote ref (this affected main before SID-65 too); an `origin/HEAD` that points outside `refs/remotes/origin/` is ignored and the lookup falls back to `main`, then `master`.
  - **Migration:** repos that relied on an uncommitted or branch-only `.harness.json` now get strict defaults (no gate run, merges denied, `main`/`master`/`origin/HEAD` protected) until a human merges the policy into the base branch on origin and runs `git fetch origin`. Repos whose policy is on a non-`main`/`master` default branch are now found (if `origin/HEAD` is set; otherwise run `git remote set-head origin --auto` once). Explicit remote-ref rewrites are now refused.
- Harness policy files can no longer be written from the shell (SID-66, security). `policy.mjs` covered only Edit/Write/MultiEdit, so `cat > .harness.json <<'J'`, `echo '{}' > .harness.json` or `cp /dev/null .claude/settings.json` was allowed, and a shell-written `.claude/settings*.json` changes Claude Code's own permissions. `pre-bash.mjs` now refuses, with or without a committed policy, any command that writes, creates, replaces, moves, links or deletes `.harness.json`, `.claude/settings.json` or `.claude/settings.local.json` (any directory, `~` and `$HOME` paths, quoted or globbed names): output redirects and heredocs, `tee`, `cp`/`install`/`rsync`/`ln`/`mv`, `rm`/`unlink`/`truncate`/`shred`, `dd of=`, `sed -i`/`perl -i`/`ruby -i`, `ed`/`ex`/`vim`/`vi`/`nano`/`emacs`, `git checkout`/`restore`/`mv`/`rm` of the file, `sh -c`/`eval` strings, and `node -e`/`python -c`/`ruby -e`/`perl -e`/`deno eval`/`bun -e` one-liners that call a write or delete. Reading, `git add`/`diff`/`log`/`show`, `git rm --cached`, `git restore --staged`, copying a policy file to another file name, and ordinary files such as `settings.json` outside `.claude/` stay allowed. A write through an existing symlink to a policy file is refused too. So are whole-directory operations on a directory named `.claude` (any parent, `~`, `$HOME`): `rm -r`/`-rf`/`-R`/`--recursive`, `mv` with it as source or destination, `cp`/`rsync`/`ln` onto it when a source is also named `.claude`, `git checkout <ref> -- .claude`, `git restore .claude` (not `--staged` alone), `git rm -r .claude` (not `--cached`); `rm -rf .claude/commands`, `mkdir -p .claude/agents` and `cp x.md .claude/commands/` stay allowed. Copying a policy-named file (`.harness.json`, `settings.json`) into an existing directory given without a trailing slash (`cp .harness.json sub` writes `sub/.harness.json`) is refused when the result is a policy path; `cp .harness.json backup/` is refused for the same reason (`backup/.harness.json` is a policy-named file), while `cp .harness.json /tmp/h.json` is allowed. Each deny message says what to do instead, and the Edit/Write deny message does as well. The check is best-effort; the backstop is SID-65, where only the base branch on origin is policy. The first `.harness.json` is documented: the agent drafts the JSON in its PR description and a human commits and merges it. Not closed: variable or indirect paths, `cd .claude` then a relative write, scripts written to a file then run, `git apply`/`patch`, and branch switches that change a tracked `.claude/settings.json`.

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

[Unreleased]: https://github.com/siddhant-angore/sflow/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/siddhant-angore/sflow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/siddhant-angore/sflow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/siddhant-angore/sflow/releases/tag/v0.1.0
