---
name: session-search
description: Search prior Hypatia session transcripts on disk. Use when the user asks about earlier research sessions, past findings, or wants to resume a prior session.
---

# Session Search

Hypatia stores session transcripts as JSONL files under `~/.hypatia/sessions/` (or `$HYPATIA_HOME/.hypatia/sessions/`). Each line is a JSON record with a `type` (session, message, model_change) and, for messages, `message.content`.

```bash
grep -ril "scaling laws" ~/.hypatia/sessions/                  # sessions that mention a topic
grep -il "scaling laws" -r ~/.hypatia/sessions/ | xargs ls -t   # newest first
```

To continue a session you found, run `hypatia --session <path>` or pick it with `hypatia --resume`.
