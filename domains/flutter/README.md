# sflow-flutter

The Flutter and Dart domain pack for sflow. Install beside `sflow`:

```
/plugin install sflow-flutter@sflow
```

Requires Dart 3.9+ (`dart mcp-server`), the Very Good CLI 1.4+ (`dart pub global activate very_good_cli`), and `jq` for the hooks.

What it adds, all vendored by commit (authors and licenses in this pack's `NOTICE.md` and `LICENSES/`; sflow's own files are under `LICENSE`):

- **Skills.** The Flutter Authors' 25 (`flutter/agent-plugins`, BSD-3-Clause), Very Good Ventures' 15 (`vgv-ai-flutter-plugin`, MIT) and 11 (`vgv-wingspan`, MIT), plus the `flutter` entry skill with the house standard.
- **MCP.** The Dart MCP server with the `cli` and `flutter_app_lifecycle` categories enabled (the official plugin leaves `run_tests`, `dart_fix`, `dart_format`, and `launch_app` off), and the Very Good CLI MCP (`create`, `test`, `packages_get`, `packages_check_licenses`).
- **Hooks.** VGV's: analyze (blocking) and format after every Dart edit, shell test and create commands redirected to MCP, a Very Good CLI version check.
- **Agents.** `flutter-reviewer` and wingspan's ten review, analysis, and research agents.
- **Playbook overlays** in `playbooks/`: Feature, Bug fix, Refactoring, Perf issue, Investigation, Opening a PR, Spec, Retro, Setup. Each names the skill or MCP tool to use at a quoted step of the core playbook. `npm run sync` fails when an anchor goes stale.

House standard: VGV conventions (very_good_analysis, Bloc, layered packages, typed go_router, green-gate to 100 percent coverage); mocking is mocktail by default and mockito's generated mocks where a package already runs build_runner and the interface is large, with one discipline for both (see the `flutter` skill); the Flutter team's skills for language and platform mechanics; `architecture: mvvm` in a project's `CLAUDE.md` switches the architecture skill. The hot-reload rule from `rules/` is applied by the overlays because Claude Code plugins do not load rules files.

The same shape makes the next pack: skills, an MCP server config, edit-time analyze and format hooks, shell commands redirected to tools, a read-only reviewer, and overlays per playbook. For a TypeScript backend that is tsc, eslint, and vitest in place of analyze, format, and test.
