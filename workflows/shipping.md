---
extends: shipping
when: Landing verified PRs.
---
- **Before** "Resolve the forge, then verify each PR independently before it lands.": Before starting a landing run, run the usage check in `usage-handoff.md` of the **sflow** skill. A run cut off mid-stack leaves PRs half-landed. If Claude Code or Grok Bot is below about 15% remaining, pause per that file, with the handoff note and the reset time in IST.
