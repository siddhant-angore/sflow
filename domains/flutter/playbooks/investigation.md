---
extends: investigation
when: A read-only question about a Dart or Flutter codebase, package, or API.
---
- **In** "Route through the **how** skill.": Resolve symbols with the `lsp` tool and read package sources with `read_package_uris` and `rip_grep_packages` before guessing an API. A question about an official API spawns `subagent_type: "sflow-flutter:official-docs-research-agent"`; a question about conventions spawns `subagent_type: "sflow-flutter:best-practices-research-agent"`, which reads the pack's skills before the web.
