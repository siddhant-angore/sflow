---
extends: setup
when: A new Flutter or Dart repository, or bringing an existing one under the pack.
---
- **Before** "Checks: pre-commit hooks per the **setup-pre-commit** skill": A new project is scaffolded with the Very Good `create` MCP tool per the **vgv-create-project** skill; data and repository layers become pure-Dart packages per the **layered-architecture** skill; a shared widget package per the **ui-package** skill; strings per the **internationalization** skill (or the **flutter-setup-localization** skill for the ARB mechanics); routes and platform deep links per the **vgv-navigation** and **flutter-setup-declarative-routing** skills. The lint set is `very_good_analysis` with `include: package:very_good_analysis/analysis_options.yaml`, and the strict analyzer modes from the **dart-run-static-analysis** skill. Coverage collection per the **dart-collect-coverage** skill.
