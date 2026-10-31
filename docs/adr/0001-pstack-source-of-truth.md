---
status: accepted
---

# pstack comes from Lauren Tan's original in cursor/plugins, not the community port

sflow vendors pstack from `cursor/plugins` at `9f844cdaac06aeaa1b2d17fbcb57e078979c6f99` instead of `michael-denyer/pstack-claude@22b5e137`. The port tracked an upstream snapshot and carried its own edits, adapters, and one extra skill. Vendoring the original gives us Lauren Tan's text and credit directly, and a diff against upstream we can read. Linear: SID-44.

## Pinned SHA

`9f844cd` is the commit immediately before `c742dd6` ("make Orchestrate agentic and delete the orch scripts"). At `9f844cd`, `pstack/` is at the state of `ab1f702`, the point the port tracked. `c742dd6` is already on `cursor/plugins` main, so pinning main would pull in the Orchestrate rewrite. That is a separate piece of work (SID-43). Do not bump the three `cursor/plugins/*` shas past `9f844cd` until SID-43 lands.

## Routing change: 108 to 48 model-invocable skills (intentional)

`npm run routing` now reports 48 model-invocable skills instead of 108. This is intentional and follows upstream's design: the original Claude Code build marks 57 of its 58 skills `disable-model-invocation: true` (only `setup-pstack` stays model-invocable), so the model reads them by path, as `docs/harness/claude-code.md` says. sflow has no override and does not re-enable them. Slash commands still work (`/sflow:sflow`, `/sflow:poteto-mode`, `/sflow:setup-pstack`, ...), and `sflow:sflow` stays model-invocable as the entry point the SessionStart hook names. Details under Consequences.

## Sub-path

Skills and agents come from `harness/pstack/claude-code/` (Lauren's generated Claude Code build of `pstack/`), because sflow is a Claude Code plugin. It has 58 skills, the agents `poteto-agent` and `comment-sicko`, and its own `LICENSE`. Assets and the README come from `pstack/` (the harness tree has no assets). We also vendor `harness/pstack/claude-code/docs/harness/` to `docs/harness/`: 23 skills tell the agent to read `../../docs/harness/claude-code.md` first, and that file maps Cursor tool, subagent, and model names to Claude Code. We also vendor `harness/pstack/claude-code/docs/guide/` (2.4 MB, 11 pages plus images) to `docs/guide/`, so the 7 guide links in `poteto-help` and the guide's own links to `../../skills/...` and `../harness/claude-code.md` resolve. `poteto-help` also links `../../README.md`, which upstream is the Claude Code build's README. In sflow the plugin root is the repo root, so that link lands on sflow's own `README.md`. We cannot vendor upstream's README to that path without replacing sflow's README, so sflow's README points to `docs/upstream/pstack-README.md` (vendored from `pstack/README.md`, which differs from the harness README only in two benny-automation links) instead.

## License handling

`cursor/plugins` has no top-level `LICENSE`. Each plugin has its own, so the manifest has one source key per subtree, all with the same repo and sha, and each key has a `licensePath`:

| key | license file | copyright |
|---|---|---|
| `cursor/plugins/pstack` | `pstack/LICENSE` | Lauren Tan |
| `cursor/plugins/cursor-team-kit` | `cursor-team-kit/LICENSE` | Cursor (plugin author Eric Zakariasson) |
| `cursor/plugins/thermos` | `thermos/LICENSE` | Cursor |

`scripts/vendor.mjs` copies `licensePath` (default `LICENSE`) into `LICENSES/<key with / as __>.LICENSE`, shares one checkout per repo and sha, and writes the `NOTICE.md` header from the manifest. Entries gained an `include` list, so one entry can take a few children of a larger tree.

## Port-only pieces

- `deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `make-pr-easy-to-review`, `what-did-i-get-done`: byte-identical in `cursor-team-kit/skills/`. Kept, sourced from there (`include`), so no other team-kit skill comes in.
- `thermos`, `thermo-nuclear-review`, `thermo-nuclear-code-quality-review` and the agents `thermo-nuclear-review-subagent` and `thermo-nuclear-code-quality-review-subagent`: sourced from `thermos/`, not from the duplicate skill in `cursor-team-kit`. The original `thermos` skill differs from the port's: it is `disable-model-invocation: true`, it has no Codex, Copilot, or Muse notes, and it names the subagents without the `pstack:` prefix.
- `babysit` skill: dropped. It has no upstream skill; the original covers it with the Babysit playbook in `poteto-mode`.
- `make-bot-ui`: new, from the original.
- `models.json` and `pi/`: dropped. Only `pi/config.ts` and the Muse PowerShell hook read `models.json`. The original `setup-pstack` and `poteto-mode` do not read it: model choices are role lines in `~/.claude/rules/pstack-models.md`, which Claude Code loads on its own. `pi/` is a Pi extension that nothing in the Claude Code plugin loads, and it depends on `models.json`.
- `hooks/`: the port's hooks are dropped entirely. That includes the SessionStart hook (`hooks.json`, `session-start.sh`, `session-start-context.md`) from `michael-denyer/pstack-claude@22b5e137`; the source, its license file, and its credit are removed. The original ships no hook. The port's mandate told the model to invoke `pstack:poteto-mode`, `pstack:tdd`, `pstack:architect`, `pstack:how`, `pstack:why`, `pstack:arena`, and `pstack:interrogate`. The original Claude Code build marks all of those `disable-model-invocation: true`, so the `Skill` tool refuses them, and the plugin namespace is `sflow:`, not `pstack:`. The port's mandate named skills the `Skill` tool refuses, so an sflow-authored SessionStart hook replaces it. The Codex, Copilot, and Muse hook files, the awk and PowerShell helpers, and `pre-tool-use.*` are gone too: they need files the original does not have, and sflow does not ship for those hosts.
- `hooks/` is now wholly sflow's own. `scripts/build-workflows.mjs` deletes it and rebuilds it from `workflows/hooks/`: the scripts go to `hooks/harness/`, and `workflows/hooks/hooks.json` becomes `hooks/hooks.json`, which `.claude-plugin/plugin.json` points at. `workflows/hooks/session-start.mjs` injects short context. For work that touches more than one file, involves a design choice, or is a bug of unknown cause or a perf issue, invoke `sflow:sflow` (model-invocable). Read pstack skills by path (`<sflow>/skills/<name>/SKILL.md`), because the `Skill` tool refuses them. User instructions take precedence. It needs only node and exits 0 with no output on any error. `npm run test:hooks` covers it.

## Consequences

- The original Claude Code build marks 57 of its 58 skills `disable-model-invocation: true` (the router, the principles, and playbooks like `tdd`, `how`, `why`, `arena`; only `setup-pstack` is model-invocable), and the model reads them by path instead of through the `Skill` tool, as `docs/harness/claude-code.md` says. `npm run routing` drops from 108 to 48 model-invocable skills. The 60 that left routing are 56 pstack skills, 3 thermos skills (`thermos`, `thermo-nuclear-review`, `thermo-nuclear-code-quality-review`, which upstream `thermos/` also marks `disable-model-invocation: true`, unlike the port), and the deleted `babysit`. `make-bot-ui` is new and not model-invocable. This is upstream's design, not an sflow regression, and there is no override. `sflow:sflow` stays model-invocable and is the entry point the SessionStart hook names.
- Two overlays quoted a line the original words differently ("driver skill" is "control skill"), so `workflows/perf-issue.md` and `domains/flutter/playbooks/perf-issue.md` were re-anchored.
- Known issue: `docs/upstream/pstack-README.md` has 107 relative links (88 distinct targets) that no longer resolve, because the README moved from `pstack/` to `docs/upstream/`. They are left as-is (vendored files are not edited); the other upstream READMEs in `docs/upstream/` and `domains/flutter/docs/upstream/` have the same problem.

## Update 2026-10-31 (SID-43)

SID-43 ported `c742dd6`: Orchestrate is agentic and the orch scripts are gone. The three `cursor/plugins/*` keys are pinned at `4dd1d05818d1` (head on 2026-10-31) and are bumped together. The `9f844cd` pin above is the original SID-44 decision and is kept as history; its "do not bump past" rule no longer applies.
