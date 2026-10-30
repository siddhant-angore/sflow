### Investigation

**You own the answer. Plan, route, write.**

Investigation requests are read-only. They produce a cited explanation or a recommendation, not a code change.

1. Route through the **how** skill. For motivation questions, also route through the **why** skill.
   - **sflow (in):** A question about an external library, API, or standard goes to primary sources per the **research** skill and the source-authority hierarchy in the **source-driven-development** skill; every claim carries its deep link or `UNVERIFIED:`. A question only another person can answer becomes a questionnaire per the **to-questionnaire** skill.
2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
3. Produce the `how`-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
4. Apply the **unslop** skill to the reply.
   - **sflow (after):** If the reader says the reply did not land, re-pitch it per the **wait-what** skill in the glossary's terms. If the answer feeds a decision that will become code, hand to the **Spec** playbook.

No PR, no babysit, no `architect` unless the investigation precedes a code change. If it does, hand back to the user and re-route to Bug fix or Feature.

**Reply:** the investigation output. For "are we sure?" answers, include your real judgment with reasons. Push back if the premise is wrong (see Autonomy).
