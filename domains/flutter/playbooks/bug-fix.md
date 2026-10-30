---
extends: bug-fix
when: A defect, crash, layout error, or failing test in a repository with a pubspec.yaml.
---
- **Before** "Reproduce it yourself on the matching surface": Launch with `launch_app`, read `get_runtime_errors` and `get_app_logs`, and inspect with `widget_inspector`. A RenderFlex overflow or unbounded-constraint error follows the error-to-fix map in the **flutter-fix-layout-issues** skill; an analyzer error follows the **dart-run-static-analysis** skill with `analyze_files` and `dart_fix`.
- **In** "Stage the commits so the failing repro lands before the fix": The regression test follows the **vgv-testing** skill (`pumpApp`), the Mocking section of the **flutter** skill for the mock library the package already uses, or `blocTest` from the **bloc** skill, and sits at the seam the bug crossed.
- **In** "Verify on the same surface.": Run the **green-gate** skill; the fix ships only after one round where all four gates are observed green.
