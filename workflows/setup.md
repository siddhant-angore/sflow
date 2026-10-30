---
extends:
when: Bringing a new or existing repository under sflow, or adding a tool only a human can authorize.
---
### Setup

1. Issue tracker and domain docs: write `docs/agents/issue-tracker.md` (the verbs create, read, list, comment, label, close, sub-issue, blocking, and what "publish to the issue tracker" and "fetch the relevant ticket" mean), `docs/agents/triage-labels.md`, and `docs/agents/domain.md` (where `GLOSSARY.md` and `docs/adr/` live), using the templates in the **setup-matt-pocock-skills** skill as the shape. Point to them from an `## Agent skills` block in `CLAUDE.md` or `AGENTS.md`.
2. Checks: pre-commit hooks per the **setup-pre-commit** skill for JavaScript or TypeScript; package boundaries per the **setup-ts-deep-modules** skill for a TS monorepo; a quality floor per the **constraint-driven-development** skill; git safety hooks per the **git-guardrails-claude-code** skill.
3. Steps only a human can do (OAuth, secrets, tokens) become a bash wizard per the **wizard** skill; never type a secret into a prompt.

**Reply:** what was installed, the checks that now run, and what the human still has to do.
