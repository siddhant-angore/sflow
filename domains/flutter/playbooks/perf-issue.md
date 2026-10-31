---
extends: perf-issue
when: Jank, slow startup, or a slow build in a repository with a pubspec.yaml.
---
- **In** "Capture a baseline trace via the matching control skill.": Launch with `launch_app` and read the widget tree with `widget_inspector`; rebuild storms and layout depth show there. Motion jank follows the decision tree in the **vgv-animations** skill (implicit before explicit, M3 `Durations` and `Easing`). Keep the attempt ledger from the core step.
