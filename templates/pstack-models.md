# pstack model configuration: the sflow default model budget (SID-143). One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit the Agent `model`). Alias entries in a panel list still count toward its fan-out.
# Tiers: sonnet for workers and reviewers, haiku for mechanical work, opus only for architecture and final verdicts. No role runs on fable.
# Escalate for one task by saying so in the request, e.g. "review this with opus xhigh"; a direct request overrides this file. To change it for good, edit the file or rerun setup-pstack.
# budget: medium (high)
feature, refactoring: sonnet high
bug-fix: sonnet high
perf-issue: sonnet high
hillclimb: sonnet high
judgment and prose: opus high
hardest tasks: opus high
how explorer: sonnet medium
how explainer: sonnet high
why investigators: sonnet high
why synthesizer: opus high
reflect tooling: sonnet high
reflect judgment, divergent, synthesizer: opus high
arena runners: sonnet high, sonnet high
arena cross-judge pool: opus high
swarm workers: sonnet high
architect runners: opus high, sonnet high
interrogate reviewers: sonnet high, sonnet high
mechanical work (renames, formatting, changelog and vendor bookkeeping, golden regen runs): haiku medium
