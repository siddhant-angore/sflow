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
