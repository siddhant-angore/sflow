# Where every skill is used

"Playbook" names the merged playbook under `skills/poteto-mode/playbooks/`. pstack's own skills keep their roles from the `poteto-mode` router and are not repeated here except where sflow adds to them.

## Define

| skill | source | playbook | role |
|---|---|---|---|
| interview-me, idea-refine | Osmani | Spec | hypothesis with a confidence number; Not Doing list |
| grilling, grill-with-docs, grill-me, domain-modeling | Pocock | Spec, Writing | the interview; glossary; ADRs |
| research, prototype, to-questionnaire, handoff | Pocock | Spec, Investigation, Pause safely | facts; runnable questions; other people's decisions; bridging |
| wayfinder | Pocock | Spec | multi-session map on the tracker |
| to-spec, spec-driven-development, constraint-driven-development | Pocock, Osmani | Spec, Perf issue, Retro | spec with six areas and three-tier boundaries; `CONSTRAINTS.md` floor |
| to-tickets, planning-and-task-breakdown | Pocock, Osmani | Spec, Feature | tracer bullets with blocking edges; task template |
| triage | Pocock | Triage | verified briefs |
| using-agent-skills | Osmani | Feature (intake) | operating behaviors; its own router section is not used |

## Build

| skill | source | playbook | role |
|---|---|---|---|
| codebase-design, api-and-interface-design, frontend-ui-engineering | Pocock, Osmani | Feature, Refactoring | architect runners' vocabulary |
| incremental-implementation, context-engineering | Osmani | Feature, Pause safely | slices; handoff contract near the context limit |
| tdd (pstack), tdd-vertical-slices (Pocock), test-driven-development, testing-patterns | all | Feature, Bug fix | confirmed seams, Prove-It, discover the stack |
| source-driven-development | Osmani | Feature, Investigation | citations or `UNVERIFIED:` |
| diagnosing-bugs, debugging-and-error-recovery | Pocock, Osmani | Bug fix, Feature | red command first, ranked hypotheses, bisect |
| browser-testing-with-devtools | Osmani | Feature, Perf issue | real-browser verification |
| doubt-driven-development | Osmani | Feature (interrogate step) | artifact and contract, never the claim |
| code-simplification, improve-codebase-architecture, setup-ts-deep-modules, migrate-to-shoehorn | Osmani, Pocock | Refactoring | fence check, deletion test, boundaries, cast migration |
| deprecation-and-migration | Osmani | Refactoring | expand and contract for external contracts |
| performance-optimization, web-performance-auditor (persona) | Osmani | Perf issue | measure first, attempt ledger, honest numbers |
| security-and-hardening | Osmani | Bug fix, Opening a PR | threat model at trust boundaries |

## Review and ship

| skill | source | playbook | role |
|---|---|---|---|
| code-review (Spec axis), code-review-and-quality, code-reviewer, security-auditor, test-engineer (personas), orchestration-patterns | Pocock, Osmani | Opening a PR | parallel fan-out, depth one; security on trust-boundary diffs; mutation experiment after |
| definition-of-done, security-checklist, accessibility-checklist, performance-checklist, observability-checklist | Osmani | Opening a PR | the implicated rows are walked, skips recorded |
| pr, git-workflow-and-versioning | Pocock, Osmani | Opening a PR | door type and didn't-touch list in Scope |
| shipping-and-launch, observability-and-instrumentation, documentation-and-adrs, ci-cd-and-automation | Osmani | Opening a PR | rollout note, on-call questions, ADRs, no skipped gates |

## Learn, pause, set up, write

| skill | source | playbook | role |
|---|---|---|---|
| retro, writing-for-agents | Pocock | Retro, Authoring or modifying a skill | environment changes; skill writing |
| ask-matt (`PHASE-BOUNDARIES.md`), claude-handoff | Pocock | Pause safely | the continue/clear/handoff/subagent/compact ladder |
| chief-of-staff | Pocock | Orchestrate | dated-wiki program memory |
| setup-matt-pocock-skills, setup-pre-commit, setup-ts-deep-modules, wizard, git-guardrails-claude-code | Pocock | Setup, Retro | tracker and domain docs as the shape; hooks; human-only steps |
| writing-fragments, writing-beats, writing-shape, loop-me, teach-workspace, wait-what | Pocock | Writing, Investigation | non-code prose |

## Present but not run as written

| skill | source | why |
|---|---|---|
| implement, implement-spec | Pocock | they commit to the current branch, open PRs, and change ticket state; Feature and Multi-phase plan with Autopilot-stack own those steps |
| ask-matt (router part) | Pocock | sflow has one router, poteto-mode; only its phase-boundary ladder is used |
| scaffold-exercises | Pocock | specific to its author's course repository |
| Osmani commands (`/spec`, `/build`, `/ship`, ...) | Osmani | not vendored; they are a second lifecycle; their skills are wired into the playbooks instead |
