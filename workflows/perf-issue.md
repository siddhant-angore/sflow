---
extends: perf-issue
when: A measured slowness, a perf regression, a bundle or query budget breach.
---
- **In** "Capture a baseline trace via the matching control skill.": Follow MEASURE, IDENTIFY, FIX, VERIFY, GUARD from the **performance-optimization** skill. Keep the attempt ledger (kept or reverted, neutral is a revert) in the PR. A web surface is profiled per the **browser-testing-with-devtools** skill; a deep audit spawns `subagent_type: "sflow:web-performance-auditor"`, which labels every number Field, Lab, or Trace.
- **In** "Plan the fix from the trace.": Check the fix against the patterns in `references/optimization-patterns.md` inside the **performance-optimization** skill and the rows of `<sflow>/references/performance-checklist.md` that the trace implicates.
- **In** "Cite the measurement in the PR.": Add the guard (a budget assertion, a CI threshold, or a `CONSTRAINTS.md` floor per the **constraint-driven-development** skill) so the regression cannot return silently.
