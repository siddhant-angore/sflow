---
extends: opening-a-pr
when: Any PR in a repository with a pubspec.yaml.
---
- **Before** "Rebase into small, ordered commits before opening PRs": Run the **green-gate** skill first; a PR opens only after one fully green round. Add to the review fan-out, depth one and in parallel: `subagent_type: "sflow-flutter:flutter-reviewer"` (read-only, one table against the bloc, testing, security, and accessibility standards), `subagent_type: "sflow-flutter:architecture-review-agent"`, `subagent_type: "sflow-flutter:test-quality-review-agent"`, and `subagent_type: "sflow-flutter:pr-readiness-review-agent"`. When `pubspec.yaml` changed, run the **license-compliance** skill (`packages_check_licenses`) and the supply-chain rows of the **static-security** skill. Every reviewer gets the diff range, never your summary.
