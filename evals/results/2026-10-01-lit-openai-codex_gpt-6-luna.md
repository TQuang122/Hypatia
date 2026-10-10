# 2026-10-01-lit-openai-codex_gpt-6-luna

| id | done | cites | valid | title | recall | wall | tokens | cost |
|---|---|---|---|---|---|---|---|---|
| q01 | yes | 16 | 100% | 100% | 100% | 633s | 4212918 | $0.086 |
| q10 | yes | 9 | 100% | 100% | 100% | 533s | 2368858 | $0.0515 |
| **all** | 100% | 25 | 100% | 100% | 100% | 1166s | 6581776 | $0.14 |

## Subagent usage by role

| id | role | actual model(s) | calls | model not reported | input | output | total | cost |
|---|---|---|---:|---:|---:|---:|---:|---:|
| q01 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 33156 | 4958 | 38114 | $0.0063 |
| q01 | researcher | openai-codex/gpt-6-luna:high | 1 | 0 | 112573 | 4579 | 117152 | $0.0164 |
| q01 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 56214 | 4678 | 60892 | $0.0113 |
| q10 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 35312 | 6554 | 41866 | $0.0084 |
| q10 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 20108 | 3737 | 23845 | $0.0043 |
