---
target: domains/flutter/hooks/hooks.json
when: Quote ${CLAUDE_PLUGIN_ROOT} in each hook command so it runs when the plugin path contains a space (SID-49).
---
# Quote the plugin root in the vendored Flutter hooks

The target is JSON text, so the replacement is JSON text. Each anchor stops before the closing quote of the JSON string, so each replacement ends in `\"`: the escaped quote that closes the shell quoting, followed by the string's own closing quote. build-workflows.mjs parses the result and fails the build if it is no longer valid JSON.

- **Replace** "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/warn-missing-mcp.sh": bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/warn-missing-mcp.sh\"
- **Replace** "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/check-vgv-cli.sh": bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/check-vgv-cli.sh\"
- **Replace** "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/block-cli-workarounds.sh": bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/block-cli-workarounds.sh\"
- **Replace** "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/analyze.sh": bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/analyze.sh\"
- **Replace** "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/format.sh": bash \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/format.sh\"
