---
extends: authoring-a-skill
when: Writing or editing a SKILL.md, AGENTS.md, or CLAUDE.md.
---
- **In** "Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve.": Write and prune the text per the **writing-for-agents** skill (context pointers, information hierarchy, leading words, `SKILL-MECHANICS.md` for frontmatter). Run `node scripts/check-routing.mjs` from the sflow root so the new description does not collide with an existing skill's.
