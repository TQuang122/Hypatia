# 2026-10-01-lit-openai-codex_gpt-5.6-terra

| id | done | cites | valid | title | recall | wall | tokens | cost |
|---|---|---|---|---|---|---|---|---|
| q01 | yes | 7 | 100% | 100% | 100% | 897s | 3792415 | $1.5592 |
| q10 | yes | 9 | 100% | 100% | 100% | 1013s | 3939261 | $1.9131 |
| **all** | 100% | 16 | 100% | 100% | 100% | 1910s | 7731676 | $3.47 |

## Subagent usage by role

| id | role | actual model(s) | calls | model not reported | input | output | total | cost |
|---|---|---|---:|---:|---:|---:|---:|---:|
| q01 | researcher | not reported | 1 | 1 | 72874 | 2617 | 75491 | $0.2266 |
| q01 | verifier | openai-codex/gpt-5.6-terra:medium | 1 | 0 | 60794 | 7605 | 68399 | $0.3172 |
| q01 | reviewer | openai-codex/gpt-5.6-terra:high | 1 | 0 | 27558 | 4342 | 31900 | $0.1245 |
| q10 | researcher | openai-codex/gpt-5.6-terra:high | 1 | 0 | 88933 | 7600 | 96533 | $0.3222 |
| q10 | verifier | openai-codex/gpt-5.6-terra:medium | 1 | 0 | 114138 | 8318 | 122456 | $0.4393 |
| q10 | reviewer | openai-codex/gpt-5.6-terra:high | 1 | 0 | 76018 | 8012 | 84030 | $0.2710 |
