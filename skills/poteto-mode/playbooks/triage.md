1. Run the **triage** skill with the roles in `docs/agents/triage-labels.md` (or its defaults). Verify the claim first: reproduce the bug with the tight command from the **diagnosing-bugs** skill, or check out the PR and run the project's checks.
2. Write the Agent Brief from `AGENT-BRIEF.md` in the **triage** skill: behavioral, testable acceptance criteria, explicit out of scope. Label `ready-for-agent` or `ready-for-human`. A brief that needs design goes to the **Spec** playbook instead.

**Reply:** each issue with its new label and the brief or the question that blocks it.
