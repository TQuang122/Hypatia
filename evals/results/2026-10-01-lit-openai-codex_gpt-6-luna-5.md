# 2026-10-01-lit-openai-codex_gpt-6-luna-5

| id | done | cites | valid | title | recall | wall | tokens | cost |
|---|---|---|---|---|---|---|---|---|
| q01 | yes | 11 | 100% | 100% | 100% | 434s | 2992159 | $0.6336 |
| q02 | yes | 13 | 100% | 100% | 100% | 821s | 5885617 | $1.1651 |
| q04 | yes | 9 | 78% | 71% | 100% | 163s | 962131 | $0.0147 |
| q07 | yes | 9 | 100% | 100% | 100% | 858s | 6370805 | $1.614 |
| q10 | yes | 16 | 100% | 100% | 100% | 471s | 4686796 | $0.9051 |
| q11 | no | 0 | - | - | 0% | 570s | 3017728 | $1.219 |
| **all** | 83% | 58 | 96% | 94% | 83% | 3317s | 23915236 | $5.55 |

## Subagent usage by role

| id | role | actual model(s) | calls | model not reported | input | output | total | cost |
|---|---|---|---:|---:|---:|---:|---:|---:|
| q01 | reviewer | openai-codex/gpt-5.6-terra:high | 1 | 0 | 98940 | 5832 | 104772 | $0.3039 |
| q01 | verifier | openai-codex/gpt-5.6-terra:medium | 1 | 0 | 73203 | 7242 | 80445 | $0.2928 |
| q02 | verifier | openai-codex/gpt-5.6-terra:medium | 1 | 0 | 77917 | 8936 | 86853 | $0.4174 |
| q02 | researcher | openai-codex/gpt-5.6-terra:high | 1 | 0 | 87426 | 8526 | 95952 | $0.3544 |
| q02 | reviewer | openai-codex/gpt-5.6-terra:high | 1 | 0 | 96082 | 7008 | 103090 | $0.3283 |
| q07 | reviewer | openai-codex/gpt-5.6-terra:high | 2 | 0 | 108428 | 12997 | 121425 | $0.6082 |
| q07 | researcher | openai-codex/gpt-5.6-terra:high | 1 | 0 | 94996 | 7031 | 102027 | $0.3513 |
| q07 | verifier | openai-codex/gpt-5.6-terra:medium | 2 | 0 | 146648 | 13092 | 159740 | $0.6011 |
| q10 | verifier | openai-codex/gpt-5.6-terra:medium | 1 | 0 | 49314 | 5596 | 54910 | $0.1966 |
| q10 | reviewer | openai-codex/gpt-5.6-terra:high | 1 | 0 | 74322 | 7049 | 81371 | $0.2710 |
| q11 | verifier | openai-codex/gpt-5.6-terra:medium | 2 | 0 | 135445 | 13615 | 149060 | $0.5021 |
| q11 | researcher | openai-codex/gpt-5.6-terra:high | 1 | 0 | 77769 | 6524 | 84293 | $0.3106 |
| q11 | reviewer | openai-codex/gpt-5.6-terra:high | 2 | 0 | 82854 | 14154 | 97008 | $0.3788 |
