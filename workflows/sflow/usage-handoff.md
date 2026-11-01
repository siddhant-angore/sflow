# Usage limits: check before big work, hand off cleanly below ~15%

A stall happens when an agent or engineer runs out of usage mid-task, with no note and no scheduled resume. Prevent it with one check before large work and a written handoff when the check fails.

## When to check

Check before **large work**: a swarm or other fan-out, a multi-file feature, a golden or snapshot regeneration, or anything you expect to take more than one session. Also check again before each new large step of a long run.

## What to check

- **Claude Code:** the remaining weekly (and session) plan usage. Run `/usage` in Claude Code, or `/status` on older versions. Note the reset time.
- **Grok Bot:** the remaining plan usage, from its usage check or the plan page. Note the reset time.

## The threshold

If **either** is below about **15%** remaining, do not start the large work. Instead:

1. Stop at a safe point, following the **Pause safely** playbook: finish or back out of the current atomic step, leave nothing half-committed (a `wip:` commit on the feature branch is fine), and push nothing new.
2. Write the handoff note below as a comment on the Linear issue, or on the tracker issue the work belongs to.
3. Tell the lead (the CTO, or whoever assigned the work) the reset time in **IST**, so the resume gets scheduled. Don't just report that you stopped.

On resume, start from the handoff note, not from memory. Rerun the check first.

The check adds no permissions, changes no hook, and never loosens a guard. Running low on usage is never a reason to skip the gate, `--no-verify`, or a review.

## Handoff note template

```markdown
**Paused: usage limit** (<Claude Code | Grok Bot> at <N>% remaining; resets <YYYY-MM-DD HH:MM> IST)

- Branch: `<branch>` at `<full head sha>` (pushed: yes/no; PR: <link or none>)
- Worktree: `<path>` (clean / `wip:` commit <sha>)
- Done and verified: <what, with the command that verified it>
- Not done: <remaining acceptance criteria>
- Next steps: 1. <first action on resume> 2. ...
- How to resume: <commands: cd, checks to rerun, what to read first>
- Gotchas: <anything a cold start would trip on; no secrets>
```
