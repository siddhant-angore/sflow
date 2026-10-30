---
extends: refactoring
when: A structural change, a simplification, an SDK or lint bump, or a dependency cleanup in a repository with a pubspec.yaml.
---
- **In** "Pin the behavior contract first.": The pin is the **green-gate** skill's observed numbers (tests passing, coverage percentage) before the first move; record them in the decision trail.
- **In** "Name the target shape.": Use the **layered-architecture** skill's done-check for layer direction and the **dart-use-pattern-matching** and **dart-use-primary-constructors** skills for Dart 3 shapes. A Flutter or Dart SDK bump follows the **dart-flutter-sdk-upgrade** skill and a lint-set bump the **very-good-analysis-upgrade** skill: both report version conflicts and never resolve them inside the bump. An ordinary pub conflict follows the **dart-resolve-package-conflicts** skill, deleting only the conflicting block of the lockfile.
- **In** "Move in small behavior-preserving steps": Rerun the **green-gate** skill after each step; a drop in the coverage number is a regression.
