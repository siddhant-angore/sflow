# sflow

One rigorous engineering workflow for coding agents, as a single installable thing. sflow merges three MIT-licensed skill sets, pinned by commit:

- **pstack** (Lauren Tan, Claude Code port by Michael Denyer): the router (`poteto-mode`), 24 principles, 28 playbooks, multi-model review, verification discipline.
- **Matt Pocock's skills**: grilling, glossary and ADRs, specs and tracer-bullet tickets, triage, diagnosis, deep-module design, retro, writing for agents.
- **Addy Osmani's agent-skills**: the define-to-ship lifecycle skills with anti-rationalization tables, seven checklists, four review personas.

Every skill is in `skills/` under one namespace. The playbooks in `skills/poteto-mode/playbooks/` carry the merged steps, marked **sflow (before|after|in)**, so the agent reads one file per task. `docs/skill-map.md` says where each of the 130 skills is used.

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

pstack's own adapters for Codex, Copilot, Muse, and Pi ship in `hooks/` and `pi/`; its `poteto-mode` skill names the Claude Code mapping it reads first.

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

## Maintain

- `npm run sync` fetches the three sources at the pinned commits, renames the two name collisions (`tdd` and `teach` from Pocock become `tdd-vertical-slices` and `teach-workspace`), applies the overlays in `workflows/`, and writes the hash lock. A stale overlay anchor fails the build.
- `npm run check` re-hashes every vendored and built file, validates the plugin, and prints the description-collision report.
- To change what sflow adds to a playbook, edit `workflows/<playbook>.md` and run `npm run sync`. Never edit a file under `skills/`, `agents/`, `references/`, `hooks/`, or `pi/` by hand.
- To upgrade a source, change its `sha` in `vendor.manifest.json` and run `npm run sync`, then `npm run check`.

Attribution for the vendored work is in `NOTICE.md` and `LICENSES/`.
