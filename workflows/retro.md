---
extends:
when: After a session or a merged PR, or when the same correction has happened twice; turns lessons into structure.
---
### Retro

1. Read the run record first: `$(git rev-parse --absolute-git-dir)/harness/runs.jsonl`, one JSON line per gate result and per Stop-hook decision. A gate that failed more than once on the same command, a `brake`, or a repeated unmet item is a lesson before anyone remembers it. Then run the **reflect** skill over the session and the **retro** skill. Propose changes to the environment, not the code.
2. Place each lesson by symptom: the wrong playbook opened means the router (`workflows/sflow/SKILL.md`); the right playbook with steps in the wrong order means the playbook overlay (`workflows/<playbook>.md`); a skill read and ignored means the skill text; something that got through means a hook (`workflows/hooks/`); a stale anchor means the overlay; a domain mistake means the pack (`domains/<d>/`).
3. Encode each lesson per the **encode-lessons-in-structure** principle: a mechanical mistake becomes a check the project runs, a `CONSTRAINTS.md` floor (the **constraint-driven-development** skill, ratchet when there is no target number), a lint, or a hook (the **git-guardrails-claude-code** skill for git safety, the **setup-pre-commit** skill for pre-commit); a judgment call goes into `CODING_STANDARDS.md`, which the reviewer reads, not the implementer; a repeated workflow becomes a playbook overlay in sflow's `workflows/` or a skill, written per the **writing-for-agents** skill and the **Authoring or modifying a skill** playbook.
4. A skill or playbook change is evaluated before it lands: the **Eval** playbook for behavior, `node scripts/check-routing.mjs` for description collisions, and `node scripts/eval-brake.mjs` when a hook changed.

**Reply:** each lesson, the structure that now enforces it, and the one that could not be encoded and why.
