---
extends: pause-safely
when: Pausing, handing work to another agent, or a fresh context window.
---
- **In** "Write the resume note off-context.": Write it with the **handoff** skill (refer to artifacts by path, redact secrets) and the session boundary contract in the **context-engineering** skill. Before pausing, apply the phase-boundary ladder in `PHASE-BOUNDARIES.md` of the **ask-matt** skill: continue, clear, handoff, subagent, then compact, first yes wins. To continue immediately in a fresh background agent, the **claude-handoff** skill. When the pause is for a usage limit, use the handoff note template and the reset-time report in `usage-handoff.md` of the **sflow** skill.
