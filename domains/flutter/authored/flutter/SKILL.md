---
name: flutter
description: The sflow Flutter and Dart domain pack. Use when the repository has a pubspec.yaml, when writing or reviewing Dart or Flutter code, or when the user says flutter, dart, widget, bloc, pubspec, or hot reload.
---

# flutter (sflow domain pack)

`<flutter>` is this pack's root, two directories above this file (the folder that holds `skills/`, `agents/`, `playbooks/`, `rules/`, and `references/`). Apply this pack when the repository has a `pubspec.yaml`.

## How the pack joins a playbook

For every playbook the sflow router opens, also open `<flutter>/playbooks/<playbook>.md` when it exists. It is a project playbook in pstack's format: copy the bundled steps into the todolist, then apply each change at the step its quoted text names. A bold skill name in those files resolves to `<flutter>/skills/<name>/SKILL.md` first, then to the core `<sflow>/skills/<name>/SKILL.md`. Review personas are `subagent_type: "sflow-flutter:<name>"`.

## House standard

Very Good Ventures' conventions are the default because they ship with enforcement: `very_good_analysis` as the lint set, Bloc or Cubit for state (the **bloc** skill: sealed events and states with Equatable, no bloc-to-bloc dependencies, the Page/View split, `blocTest`), the layered monorepo from the **layered-architecture** skill, typed `go_router` routes from the **vgv-navigation** skill, `pumpApp` and `TestTag` from the **vgv-testing** skill, 100 percent coverage through the **green-gate** skill. The Flutter team's skills cover the Dart language and platform mechanics (pattern matching, primary constructors, FFI, docs, coverage, deep-link configuration, responsive layout, widget previews, layout-error fixes). Where the two disagree, VGV wins, unless the project's `CLAUDE.md` says `architecture: mvvm`, in which case the **flutter-apply-architecture-best-practices** skill is the architecture.

## Mocking: the best of mocktail and mockito

One library per package, chosen by this rule, and the same discipline whichever it is.

- **Default mocktail** (the **vgv-testing** skill): no codegen, so the red-green loop stays a test run, not a build. Private `_MockFoo extends Mock implements Foo` classes, `registerFallbackValue` once in `setUpAll` for every custom type passed to `any()`, `MockBloc` and `MockCubit` from `bloc_test` for state.
- **Use mockito's generated mocks** (the **dart-generate-test-mocks** skill) when the package already runs `build_runner` for other codegen and the interface is large, generic-heavy, or changes often: `@GenerateNiceMocks([MockSpec<Foo>()])` keeps the mock in step with the interface at build time, and a stale mock fails the build instead of the test. Never hand-edit generated `.mocks.dart`; commit it only if the project commits other generated files.
- **Both libraries, always:** stub `Future` and `Stream` members with `thenAnswer`, never `thenReturn`; mock only at module boundaries (repositories, clients, platform channels), never your own value types or widgets; verify behavior the caller observes, not call counts, unless the count is the contract; one mock per collaborator per test file, created in `setUp` inside the `group`.
- **Never** mix the two in one package, mock a Bloc with anything but `MockBloc`, or reach for a mock where a fake (an in-memory repository) reads better.

## Tools in force

- Dart MCP server (`dart mcp-server --enable cli --enable flutter_app_lifecycle`): `analyze_files`, `dart_fix`, `dart_format`, `run_tests`, `pub`, `pub_dev_search`, `launch_app`, `stop_app`, `list_devices`, `get_app_logs`, `get_runtime_errors`, `hot_reload`, `hot_restart`, `widget_inspector`, `flutter_driver_command`, `lsp`. Prefer these over the shell.
- Very Good CLI MCP (`very_good mcp`, CLI 1.4 or later): `create`, `test` (coverage, min_coverage, show_uncovered), `packages_get`, `packages_check_licenses`.
- Hooks (from the vgv-ai-flutter-plugin, vendored): after every Dart edit `dart analyze` runs and blocks on an error, then `dart format`; `flutter test`, `dart test`, `flutter create`, and `very_good *` in Bash are refused in favor of the MCP tools; a SessionStart note warns when the Very Good CLI is missing or old.
- Hot reload rule (`<flutter>/rules/flutter-hot-reload.md`, not loaded by Claude Code on its own): after editing a `.dart` file under `lib/` while an app runs, call `hot_reload`, or `hot_restart` when `main()`, `initState`, or global state changed. Skip for edits outside `lib/` or comment-only edits.

## Not run as written

`wingspan-build`, `wingspan-plan`, `wingspan-review`, `wingspan-create-pr`, `wingspan-hotfix`, `wingspan-brainstorm`, `wingspan-create`: a second lifecycle that commits, pushes, and opens PRs. Their reviewers, templates, and success-criteria format are used by the overlays; the lifecycle is sflow's. `very-good-analysis-upgrade` commits and opens a PR by itself; run it inside the Refactoring playbook and let Opening a PR do the PR.
