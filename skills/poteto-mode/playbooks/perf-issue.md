### Perf issue

**You own the measurement story. Plan, review, verify the numbers.** Tie every fix to a measurement, don't read source instead of measuring.

1. Capture a baseline trace via the matching driver skill. Vet the baseline, and each later number, with the **benchmark-checklist** skill.
   - **sflow (in):** Follow MEASURE, IDENTIFY, FIX, VERIFY, GUARD from the **performance-optimization** skill. Keep the attempt ledger (kept or reverted, neutral is a revert) in the PR. A web surface is profiled per the **browser-testing-with-devtools** skill; a deep audit spawns `subagent_type: "sflow:web-performance-auditor"`, which labels every number Field, Lab, or Trace.
2. `how` to ground hypotheses. Don't claim a perf ceiling without running it first.
   Try the performance mantras in order, cheapest first:
   1. Don't do it. Stop work whose result nothing uses rather than cheapening it.
   2. Do it, but don't do it again.
   3. Do it less.
   4. Do it later.
   5. Do it when they're not looking.
   6. Do it concurrently.
   7. Do it cheaper.

   When an earlier mantra meets the target, stop.
3. Plan the fix from the trace. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured perf-issue model (default in poteto-mode's Models section). Pick each subagent's reasoning level for the job, per the Subagents section. Review the diff. Capture a post-fix trace.
   - **sflow (in):** Check the fix against the patterns in `references/optimization-patterns.md` inside the **performance-optimization** skill and the rows of `<sflow>/references/performance-checklist.md` that the trace implicates.
   Apply the **sequence-verifiable-units** principle skill, verifying each attempt before trying the next.
4. Parse and compare the artifacts (JSON to sqlite, diff). "Inconclusive" or wrong-surface is not a pass. Flag it.
5. Cite the measurement in the PR.
   - **sflow (in):** Add the guard (a budget assertion, a CI threshold, or a `CONSTRAINTS.md` floor per the **constraint-driven-development** skill) so the regression cannot return silently.
6. Run **Opening a PR**.

For sustained improvement against a metric rather than a one-off fix, use the Hillclimb playbook (`playbooks/hillclimb.md`).

**Reply:** baseline number, post-fix number, delta, artifact path.
