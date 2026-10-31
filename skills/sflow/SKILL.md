---
name: sflow
description: The entry point for any engineering task in sflow. Use when starting a task, when unsure which workflow or skill applies, or when the user says sflow, flow, poteto-mode, or asks to do something rigorously.
---

# sflow

`<sflow>` is the plugin root, the folder that holds `skills/`, `agents/`, and `references/`. Bundled skills live at `<sflow>/skills/<name>/SKILL.md`; the review personas are `subagent_type: "sflow:<name>"`.

Read `../poteto-mode/SKILL.md` in full and follow it. It is the router. Its playbooks already carry the sflow steps, marked **sflow (before|after|in)**, so one playbook file is the whole procedure. When a playbook names a skill in bold, read that skill at `<sflow>/skills/<name>/SKILL.md` and follow it; the Skill tool cannot fire the user-invoked ones.

## Task to playbook

| task at hand | playbook |
|---|---|
| an idea, a vague ask, a task without acceptance criteria | Spec (with the human) |
| incoming bugs or requests not yet agent-ready | Triage |
| new or changed behavior | Feature |
| a defect, crash, or regression | Bug fix |
| a structural change, simplification, or migration | Refactoring, or figure-it-out when cross-cutting |
| measured slowness | Perf issue, or Hillclimb for sustained work |
| a read-only question | Investigation |
| a design fork a run can settle | Prototype |
| many PRs or a program | Multi-phase plan, then Autopilot-stack or Orchestrate |
| any PR | Opening a PR, automatic at the end of every playbook |
| pause or hand over | Pause safely |
| after a session | Retro |
| a new repo or a tool only a human can authorize | Setup |
| prose that is not code | Writing |
| a SKILL.md, AGENTS.md, or CLAUDE.md | Authoring or modifying a skill |

Skills from all three sources are in `skills/`; `<sflow>/docs/skill-map.md` says where each one is used.

## Hooks in force

The guard is always on, in every git repository: with no policy committed, `main`, `master` and the remote default branch are protected and merges are denied. The policy comes only from `.harness.json` on the base branch on origin; a working-tree or branch-only copy is ignored until a human merges it and runs `git fetch origin`, and the gate and the Stop hook run only once a policy is committed. Force pushes, pushes to a protected branch, discards, history rewrites, merges, releases, and GitHub write calls are refused; `.harness.json` and `.claude/settings.json` are read-only to you; `git push` and `gh pr create` run the `gate` commands first and scan the pushed range for secrets; the Stop hook lists unmet definition-of-done items once per repo state and, after three non-converging attempts, demands an auditable failure report instead of a fourth. Fix causes, never hooks. Every gate result and Stop decision is appended to `<git dir>/harness/runs.jsonl`; the Retro playbook reads it.

## Where a failure lives

| symptom | layer | file |
|---|---|---|
| the wrong playbook opened | router | `workflows/sflow/SKILL.md`, the task table |
| right playbook, a step in the wrong place or missing | playbook overlay | `workflows/<playbook>.md` |
| a skill was read and its rule ignored | skill text | `skills/<name>/SKILL.md` (vendored: fix upstream or override in an overlay) |
| something irreversible got through, or a loop did not stop | hook | `workflows/hooks/` |
| a change was applied at the wrong step after an upgrade | stale anchor | the overlay; `npm run sync` reports it |
| a domain convention was wrong | domain pack | `domains/<d>/` |

## Domain packs

A domain pack is a sibling plugin named `sflow-<domain>` with its own skills, MCP servers, hooks, agents, and `playbooks/` overlays in pstack's project-playbook format. When one is enabled and its entry skill's condition matches the repository (for `sflow-flutter`, a `pubspec.yaml`), read `/sflow-<domain>:<domain>` first, then open the pack's overlay for every playbook you run beside the core playbook, and apply its changes at the quoted steps.
