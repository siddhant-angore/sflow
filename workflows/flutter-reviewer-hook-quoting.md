---
target: domains/flutter/agents/flutter-reviewer.md
when: Quote ${CLAUDE_PLUGIN_ROOT} in the agent's frontmatter hook command so it runs when the plugin path contains a space (SID-49).
---
# Quote the plugin root in the vendored flutter-reviewer hook

The hook sits in the agent's YAML frontmatter as a double-quoted YAML string, so the inner quotes are escaped (`\"`), the same as in the JSON hooks overlay.

- **Replace** "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/allow-readonly-git.sh": bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/allow-readonly-git.sh\"
