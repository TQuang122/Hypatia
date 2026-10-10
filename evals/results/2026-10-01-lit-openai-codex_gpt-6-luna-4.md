# 2026-10-01-lit-openai-codex_gpt-6-luna-4

| id | done | cites | valid | title | recall | wall | tokens | cost |
|---|---|---|---|---|---|---|---|---|
| q01 | yes | 12 | 100% | 100% | 100% | 297s | 3121935 | $0.0648 |
| q02 | yes | 8 | 100% | 100% | 100% | 474s | 4845290 | $0.0921 |
| q04 | yes | 9 | 100% | 100% | 100% | 648s | 4510024 | $0.0931 |
| q07 | yes | 5 | 100% | 100% | 100% | 304s | 3014865 | $0.0651 |
| q10 | yes | 14 | 100% | 100% | 100% | 656s | 4130003 | $0.0796 |
| q11 | yes | 9 | 100% | 100% | 100% | 262s | 1253281 | $0.0248 |
| **all** | 100% | 57 | 100% | 100% | 100% | 2641s | 20875398 | $0.42 |

## Subagent usage by role

| id | role | actual model(s) | calls | model not reported | input | output | total | cost |
|---|---|---|---:|---:|---:|---:|---:|---:|
| q01 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 46655 | 3542 | 50197 | $0.0072 |
| q01 | researcher | openai-codex/gpt-6-luna:high | 1 | 0 | 72749 | 4542 | 77291 | $0.0110 |
| q02 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 17976 | 4427 | 22403 | $0.0043 |
| q02 | verifier | openai-codex/gpt-6-luna:medium | 2 | 0 | 74897 | 7301 | 82198 | $0.0124 |
| q02 | researcher | openai-codex/gpt-6-luna:high | 1 | 0 | 78448 | 4430 | 82878 | $0.0121 |
| q04 | researcher | openai-codex/gpt-6-luna:high | 2 | 0 | 119347 | 11260 | 130607 | $0.0229 |
| q04 | verifier | openai-codex/gpt-6-luna:medium | 2 | 0 | 140542 | 6183 | 146725 | $0.0213 |
| q04 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 8963 | 3629 | 12592 | $0.0030 |
| q07 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 85623 | 4527 | 90150 | $0.0145 |
| q07 | researcher | openai-codex/gpt-6-luna:high | 1 | 0 | 58777 | 3629 | 62406 | $0.0097 |
| q07 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 21873 | 3384 | 25257 | $0.0044 |
| q10 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 29083 | 5164 | 34247 | $0.0064 |
| q10 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 22211 | 3820 | 26031 | $0.0045 |
