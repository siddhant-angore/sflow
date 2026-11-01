# sflow

One rigorous engineering workflow for coding agents, as a single installable thing. sflow merges MIT-licensed skill sets, pinned by commit (the `sflow-flutter` pack adds BSD-3-Clause work by The Flutter Authors and MIT work by Very Good Ventures):

- **pstack by Lauren Tan (poteto)**, https://github.com/cursor/plugins/tree/main/pstack, taken from its Claude Code build in `harness/pstack/claude-code/`: the router (`poteto-mode`), 24 principles, 23 playbooks, multi-model review, verification discipline. sflow's overlays add 5 more playbooks. pstack's own README is vendored at `docs/upstream/pstack-README.md` and its guide at `docs/guide/`; pstack links to `../../README.md` (for example in `poteto-help`) land on this file, because sflow's plugin root is this repo's root.
- **Cursor's `cursor-team-kit` and `thermos` plugins** (https://github.com/cursor/plugins, same commit as pstack): the `deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `make-pr-easy-to-review`, and `what-did-i-get-done` skills from `cursor-team-kit` (plugin author Eric Zakariasson), and the `thermos`, `thermo-nuclear-review`, and `thermo-nuclear-code-quality-review` skills with their two review subagents from `thermos`.
- **Matt Pocock's skills**: grilling, glossary and ADRs, specs and tracer-bullet tickets, triage, diagnosis, deep-module design, retro, writing for agents.
- **Addy Osmani's agent-skills**: the define-to-ship lifecycle skills with anti-rationalization tables, seven checklists, four review personas.

Every skill is in `skills/` under one namespace. The playbooks in `skills/poteto-mode/playbooks/` carry the merged steps, marked **sflow (before|after|in)**, so the agent reads one file per task. `docs/skill-map.md` says where each of the 131 skills is used.

## Install

Claude Code:

```
/plugin marketplace add siddhant-angore/sflow
/plugin install sflow@sflow
```

Then start any task with `/sflow:sflow` (or `/sflow:poteto-mode`). Run `/sflow:setup-pstack` once to choose the models each role uses.

Domain packs are sibling plugins in the same marketplace. For Flutter and Dart:

```
/plugin install sflow-flutter@sflow
```

See `domains/flutter/README.md`. A pack adds skills, MCP servers, hooks, review agents, and per-playbook overlays; the core router applies them when the repository matches (a `pubspec.yaml` for Flutter). The same shape is the template for the next stack.

Other agents (Codex, Cursor, Copilot, Gemini CLI, and any host that reads `skills/<name>/SKILL.md`):

```
npx skills add siddhant-angore/sflow
```

pstack's Claude Code build tells its skills to read `docs/harness/claude-code.md` first, which maps pstack's Cursor tool and model names to Claude Code; sflow vendors that file. The Codex, Copilot, Muse, and Pi adapters from the former community port are not shipped (see `docs/adr/0001-pstack-source-of-truth.md`). The original marks its router, principles, and playbooks `disable-model-invocation: true`, so the `Skill` tool refuses them and the model reads them by path instead. sflow's own SessionStart hook (`workflows/hooks/session-start.mjs`) tells the agent to invoke `sflow:sflow` for multi-file, design, and unknown-cause work, and how to read the pstack skills.

## Use

| task at hand | say | playbook the router opens |
|---|---|---|
| an idea or a task without acceptance criteria | `/sflow:sflow spec out X` | Spec (interview, glossary, ADRs, spec, tickets) |
| a feature | `/sflow:sflow build X` | Feature |
| a bug | `/sflow:sflow fix X` | Bug fix |
| a cleanup or migration | `/sflow:sflow refactor X` | Refactoring |
| slowness | `/sflow:sflow X is slow` | Perf issue |
| a question | `/sflow:sflow how does X work` | Investigation |
| a PR | automatic | Opening a PR, with the review fan-out |
| after a session | `/sflow:sflow retro` | Retro |

## Harness hooks

sflow ships the hooks that a review found every harness assumes and most lack. The guard is always on, in every git repository: with no policy committed, the protected branches are `main`, `master` and the remote default branch (`origin/HEAD`), and merges are denied. A `.harness.json` committed on the base branch on origin adds the gate, the Stop/DoD hook, `allowMerge` and custom `protectedBranches`:

```json
{ "protectedBranches": ["main"], "allowMerge": false, "gate": ["npm run lint && npm test"], "dod": [] }
```

- Guard: no force or `+` push, no push to a protected branch, no `reset --hard`, `clean -f`, `branch -D`, history rewrite, `--no-verify`, deleting, moving or un-executing git hooks (`.git/hooks`, `.git/sflow-hooks`, `.husky`), `gh pr merge`, GitHub write API call, release, or publish. `protectedBranches: []` turns off only the push rule for a solo repo. Rules run on the command as the shell reads it, so quotes and backslashes can't split a guarded word (`gh pr "merge"`, `ma\in`). What the guard can't read fails closed: an unclosed quote, `eval $X`, and a shell variable or `$( )` in a git argument that could be a denied value (`git checkout $BRANCH`). Write such values out literally; message options such as `-m "$MSG"` are fine.
- Policy: `.harness.json` and `.claude/settings*.json` are read-only to the agent, through the file tools and through the shell (redirection and heredocs, `tee`, `cp`/`mv`/`ln`/`install`/`rsync`, `rm`/`truncate`/`dd`, `sed -i` and similar in-place editors, `git checkout`/`restore`/`mv`/`rm` of the file, and `node -e`/`python -c`-style one-liners that write it; also deleting, moving or replacing a whole `.claude` directory, and copying onto the repo-root `.harness.json` or a `.claude/settings*.json`, including through a directory destination such as `cp sub/.harness.json .`). Reading is never refused: `cat`, `jq`, `git show`/`diff`/`log`, read-only one-liners, and copying a policy file elsewhere (`cp .harness.json backup/`). The shell check is best-effort (no variable expansion, no scripts run from files); the backstop is that only the base branch on origin is policy. The policy is read from the base branch on origin (the branch `origin/HEAD` points at, then `main`, then `master`) and the base branch stays protected unless `protectedBranches` is `[]`. The working tree is never read as policy: an uncommitted or branch-only `.harness.json` is ignored until it is merged, and deny messages and the SessionStart context say which policy is in force. Local rewrites of remote-tracking refs (`git remote set-head <remote> <branch>`, `git symbolic-ref`/`git update-ref` on `refs/remotes/`, `git fetch`/`git pull` into `refs/remotes/` through an explicit refspec, writes to `remote.<name>.fetch` via `git config`, `-c`, or `GIT_CONFIG_*` env) are refused, because they locate the policy; each deny message names the allowed alternative. Plain `git fetch`/`git pull` (with `--prune`, `--all`, a branch, or a local-branch refspec), `git remote set-head <remote> --auto`, config reads, and other `-c`/`GIT_CONFIG_*` settings stay allowed. `gh repo edit` is refused too (it can change the default branch); `gh repo view` stays allowed. Replace refs are ignored by the hooks and writes to `refs/replace/` are refused (`git replace -l` stays allowed), `git symbolic-ref HEAD <target>` outside `refs/heads/` is refused (use `git switch`), and writes to the repo-discovery config keys (`core.bare`, `core.repositoryformatversion`, `core.worktree`, `include.path`, `includeIf.*`) are refused; if git can't read the repository the guard applies strict defaults. A push must name its branch when the hook can't tell which one it updates (cwd inside `.git`, `core.bare`, or `git -C`/`--git-dir`/`GIT_DIR=`/`cd` retargeting): use `git push origin <branch>`.
- Adopting a policy (the sanctioned bootstrap): the agent may draft the JSON, starting from `templates/harness.json`, in its PR description. A human commits `.harness.json` on a branch, opens and merges the PR, then runs `git fetch origin`. If the repo was not cloned (no `origin/HEAD`), run `git remote set-head origin --auto` once.
- Gate: `git push` and `gh pr create` run the `gate` commands first (`{base}` is the merge base), skip when HEAD already passed, and scan the pushed range for secret-shaped text.
- Stop: unmet definition-of-done items block the turn once per repo state; after three non-converging attempts the hook demands an auditable failure report and then lets the turn end. Hooks fail closed.
- Unusable policy (SID-82, SID-83): if `.harness.json` exists on origin's base branch but can't be used (not valid JSON, not an object, over 1 MB, or unreadable), it is not skipped for the next candidate branch. Every shell command is denied (fail-closed) with the reason and the fix: a human corrects it on that branch and runs `git fetch origin`. SessionStart shows the same note.
- Git hooks outside Claude (SID-147): `npm run hooks -- install [--repo <dir>]...` makes every shell `git commit` and `git push` in a repo, by an agent or a person, run the same guard and gate code as the Claude hook.
  - **A human runs it once per repo, outside Claude.** Agents are denied `git config core.hooksPath` on purpose, so they can't install it. They also can't remove it: `--no-verify`, `-c core.hooksPath=…`, `git config --remove-section core`, `git config --edit`, writes to `sflow.*` keys, and deleting, moving, overwriting or un-executing hooks are all denied (SID-155).
  - Install writes small stubs to `<git common dir>/sflow-hooks/` and points `core.hooksPath` there. It is idempotent: a rerun rewrites nothing.
  - Install keeps your existing hooks. A previous `core.hooksPath` (husky, lefthook) is saved in `<git common dir>/sflow-hooks/previous-hooks-path`, where the guard denies agent writes, not in git config. It must resolve inside the repo's git dir or working tree; install refuses one outside, and a hook whose saved path no longer passes fails closed. Each stub first runs the repo's own hook of that name, from the saved path or else `.git/hooks`, and then sflow's checks. Either failing fails the commit or push. Every executable hook already there gets a stub, so none is turned off.
  - **pre-push:** each ref update is judged as the `git push` command an agent would type: a non-fast-forward counts as `--force`, and a deletion as `--delete`. The pre-push hook refuses whatever the guard refuses (protected branch, force, delete) and then runs the gate on HEAD. It prints `sflow gate ok <sha>`, or `sflow gate skipped: <reason>` when origin has no policy or an empty gate. With a gate in force, a push of a commit other than HEAD is refused, so nothing goes out unchecked. That also refuses multi-branch pushes (`git push origin a b`) and `git push --all`: push one branch at a time, from that branch.
  - **pre-commit:** refuses staged secret-shaped text, using the push scan's patterns, and the guard's verdict on `git commit`.
  - No environment variable turns the hooks off. If the sflow checkout the stubs point at is moved or deleted, they fail closed. `npm run hooks -- check [--repo <dir>]...` exits 1 and says so when the hooks are not installed, are stale, or are not executable.
- Run record: `<git dir>/harness/runs.jsonl` holds every gate result and Stop decision; the Retro playbook turns repeats into structure.

`npm run eval:brake [-- --runs N --model haiku]` is the behavioral eval: a live model in a scratch repo with a failing gate must neither push nor claim success. It needs an authenticated `claude` CLI and costs about $0.01 per run on haiku. Exit 0 means the brake held, 1 means the brake failed, 2 means a harness/CLI error (rerun); a transient CLI error (rate limit, overload, connection error, refused or reset socket, a network timeout the CLI reports) is retried once automatically, but the 600 s kill is permanent and never retried. `--runs` is capped at 5 (a message says so); a missing or non-positive-integer `--runs` value is a usage error (exit 2). Scratch repos in the temp dir are removed after a passing run and kept, with their paths printed, after a failure (`SFLOW_EVAL_KEEP_SCRATCH=1` keeps them always; `SFLOW_EVAL_RETRY_DELAY_MS` shortens the retry wait). The offline tests are `npm run test:eval-brake`.

## Model budget

sflow ships a default pstack model budget in `templates/pstack-models.md`, so a swarm does not fall back to opus at `xhigh` for every role. The tiers:

- **sonnet** for workers and reviewers: feature, bug-fix, perf and hillclimb delegates, swarm workers, arena runners, interrogate reviewers, `how` explorers and explainers, `why` investigators, and the reflect tooling reviewer.
- **haiku** for mechanical work: renames, formatting, changelog and vendor bookkeeping, and golden regen runs.
- **opus**, only for architecture and final verdicts: architect runners (one opus and one sonnet seat), judgment and prose, hardest tasks, the `why` synthesizer, reflect judgment, and the arena cross-judge.

Every role runs at `high` effort or lower (`how` explorers and mechanical work at `medium`). No role runs on fable or at `xhigh` or `max`.

Claude Code loads every `.md` in `<config>/rules/` into each session ([docs/harness/claude-code.md](docs/harness/claude-code.md#models)). `<config>` is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset.

- `npm run model-budget -- install [--config <dir>]...` writes the sheet to `<config>/rules/pstack-models.md` in each config.
  - A sheet that already exists and differs is kept, so your own choices survive a refresh. `--force` replaces it, after copying it to `pstack-models.md.bak-<UTC timestamp>` next to it and printing that path. The backup does not end in `.md`, because Claude Code loads every `.md` in `rules/`, and a second sheet would load too.
  - A symlink at the sheet path is refused, with or without `--force`, so nothing is written through it.
  - It writes nothing else: no settings, no permissions, no `CLAUDE.md`.
- `npm run model-budget -- check [--config <dir>]...` prints each config's sheet as `ok` (the sflow default), `ok custom`, `MISSING` or `INVALID`.
  - It exits `1` unless every config has a sheet whose models and efforts all exist.
- Run `install` and then `check` for every engineer config on a machine after each install or refresh of the plugin. Pass one `--config` per `CLAUDE_CONFIG_DIR`.

**Escalate for one task** by saying so in the request, for example "review this with opus xhigh" or "run the swarm workers on opus". A direct request overrides the sheet. To change a tier for good, edit `<config>/rules/pstack-models.md` (`install` then keeps your edit) or rerun `setup-pstack`. To go back to the sflow default, run `install --force`.

**If you rerun `setup-pstack`**, two lines drift from this sheet:

- `mechanical work (...)` is not a pstack role. No pstack skill reads it, and `setup-pstack` drops lines whose role it does not know. So the haiku tier only steers work when an agent reads the sheet as guidance, and a rerun deletes it.
- Under the `medium (high)` budget, a rerun sets every effort to `high` and keeps only family, list and alias changes. So `how explorer: sonnet medium` goes back to `high`.

Run `install --force` afterwards to restore the sflow default; it keeps a backup of what `setup-pstack` wrote.

Arena never picks a judge from the parent's model family. With only Claude models, a Claude parent therefore skips the cross-judge and picks the base itself.

`npm run test:model-budget` checks the tiers in the shipped sheet and covers `install` and `check` offline. `npm run check` runs it.

## Maintain

- `npm run sync` fetches every source in `vendor.manifest.json` at its pinned commit, renames the two name collisions (`tdd` and `teach` from Pocock become `tdd-vertical-slices` and `teach-workspace`), applies the overlays in `workflows/`, and writes the hash lock. A stale overlay anchor fails the build. It also copies each domain pack's licenses and writes its `NOTICE.md`, because a pack is installed from its own directory and so carries its own.
- `npm run check` re-hashes every vendored and built file, validates the plugin, and prints the description-collision report. It fails on a missing, orphan or stale pack license or `NOTICE.md`.
- To change what sflow adds to a playbook, edit `workflows/<playbook>.md` and run `npm run sync`. Never edit a file under `skills/`, `agents/`, `references/`, `hooks/` (`workflows/hooks/` builds all of it), or `docs/harness/` by hand.
- To upgrade a source, change its `sha` in `vendor.manifest.json` and run `npm run sync`, then `npm run check`. The three `cursor/plugins/*` sources share one repo and sha but have separate keys, because that repo has no top-level license: each key's `licensePath` points at the plugin's own `LICENSE`. Bump all three together.
- `npm run upstream` compares every pinned `sha` with the upstream default branch. It is read-only and needs no token. Per source it prints the pinned and head shas, the branch, the commits ahead that touch the vendored paths or the source's licence file (`licensePath`, default `LICENSE`; unrelated monorepo commits do not count) next to the total, a compare link, and, when behind, the changed files, new or removed skill directories (a new name that collides with an existing directory is flagged), and the overlays in `workflows/` and `domains/*/playbooks/` whose anchored file changed upstream. Pass `--json` for a machine-readable report. `--from-json <file>` prints the text report from a saved `--json` report without touching the network (exit `0`; exit `2` if the file argument is missing). Several source keys that share one repo are fetched once.
  - Exit `0`: every source is current or held. Exit `10`: some source is behind. Exit `1`: an error, meaning a pinned sha no longer exists upstream or is not on the default branch, a source key's `sha` differs between `vendor.manifest.json` and `vendor.lock.json`, a key is in only one of those files, or the network failed. Error wins over drift. The lock comparison checks only those keys and shas; it does not re-hash files (that is `npm run check`).
  - To defer an upgrade, add `"hold": "<reason>"` to the source in `vendor.manifest.json`, for example `"hold": "SID-NN"`. A held source that is behind reports `HELD` with the reason and does not cause exit `10`; an error on it still exits `1`. Remove `hold` when the reason is resolved.
  - Overlay flags are a simple map: `extends: X` is `skills/poteto-mode/playbooks/X.md` (or the `target:` path), traced back through the manifest entry to its upstream path. It does not read the anchor text, so a flag means "look", not "broken".
  - `npm run test:upstream` covers it offline: a stubbed git for the report logic, and one real-git test that runs the script against a local bare repo over `file://`. `npm run check` runs it.
- `npm run test:vendor` covers `scripts/vendor.mjs` sync and check offline against local fixture upstreams over `file://`, and `scripts/check-versions.mjs`. `npm run check` runs both.
- `.github/workflows/upstream.yml` runs `npm run upstream` every Monday at 03:30 UTC (09:00 IST) and on demand. On exit `1` it waits 30 seconds and retries once, and the retry's result counts. On drift it opens or updates one issue labelled `upstream-drift`. On an error it comments on that open issue, or opens one, and fails the job. The workflow makes one network run with `--json` and renders `report.txt` from it with `--from-json`; stderr from that run is appended to `report.txt`. When every source is current or held it closes the open issue with a comment. The comment lists each held source as `- <source>: <hold> [<status>]`, and a held source whose status is `current` gets `STALE HOLD: upstream is current; remove the hold`. If `report.json` is empty or invalid, the step fails and the issue stays open. Reports in issues are capped at 60,000 characters, with a link to the run log for the full text. It never opens a PR or merges.
- The upgrade loop when the report says behind: read the report, bump `sha` in `vendor.manifest.json`, run `npm run sync`, re-anchor any overlay that fails or was flagged, run `npm run check`, and open a PR, with a `CHANGELOG.md` entry.
- CI (`.github/workflows/ci.yml`) runs on every PR and on push to `main`: it fails on any tracked symlink, then runs `npm run check` (vendor hashes, plugin validate, hooks, routing), plus a separate vendor drift job (`node scripts/vendor.mjs sync` must leave the tree clean). It uses no secrets. `npm run eval:brake` makes a paid live Claude call, so it is manual and never runs in CI.
- On release, add the entries to `CHANGELOG.md` (including upstream pin changes), bump the version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both plugin entries), and `domains/flutter/.claude-plugin/plugin.json` together. Before tagging, install `sflow-flutter` into a throwaway `CLAUDE_CONFIG_DIR` from a local marketplace and confirm the cache copy has `LICENSE`, `NOTICE.md` and `LICENSES/`. Then create an annotated tag on the bump commit (`git tag -a vX.Y.Z -m "sflow vX.Y.Z"`) and push it.

Attribution for the vendored work is in `NOTICE.md` and `LICENSES/`. Credit goes to Lauren Tan (pstack), Cursor (`cursor-team-kit`, author Eric Zakariasson, and `thermos`), Matt Pocock, Addy Osmani, Very Good Ventures, and The Flutter Authors.

The sflow mark (`assets/sflow-mark.*`, `domains/flutter/assets/sflow-mark.*`) is sflow's own brand asset (Brand Designer / Siddhant Angore), not third-party.
