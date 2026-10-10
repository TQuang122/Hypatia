# 2026-10-02-lit-openai-codex_gpt-6-luna

| id | done | cites | valid | title | recall | wall | tokens | cost |
|---|---|---|---|---|---|---|---|---|
| q01 | yes | 11 | - | - | 100% | 654s | 3658524 | $0.0812 |
| q02 | yes | 17 | - | - | 100% | 762s | 4658094 | $0.0903 |
| q04 | yes | 4 | 100% | 100% | 100% | 319s | 1202719 | $0.0286 |
| q07 | yes | 5 | 100% | 100% | 100% | 598s | 4631950 | $0.0825 |
| q10 | yes | 6 | 100% | 100% | 100% | 720s | 2943682 | $0.0705 |
| q11 | yes | 11 | 100% | 100% | 100% | 598s | 3964822 | $0.0824 |
| **all** | 100% | 54 | 100% | 100% | 100% | 3651s | 21059791 | $0.44 |

## Subagent usage by role

| id | role | actual model(s) | calls | model not reported | input | output | total | cost |
|---|---|---|---:|---:|---:|---:|---:|---:|
| q01 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 33856 | 3330 | 37186 | $0.0058 |
| q01 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 55831 | 4354 | 60185 | $0.0085 |
| q02 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 25219 | 6753 | 31972 | $0.0069 |
| q02 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 35544 | 4234 | 39778 | $0.0065 |
| q04 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 23738 | 2657 | 26395 | $0.0046 |
| q04 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 18203 | 3053 | 21256 | $0.0037 |
| q07 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 49050 | 4143 | 53193 | $0.0087 |
| q07 | researcher | openai-codex/gpt-6-luna:high | 1 | 0 | 55363 | 4672 | 60035 | $0.0100 |
| q07 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 26792 | 4199 | 30991 | $0.0051 |
| q10 | researcher | openai-codex/gpt-6-luna:high | 1 | 0 | 71995 | 3922 | 75917 | $0.0113 |
| q10 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 27207 | 5203 | 32410 | $0.0062 |
| q10 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 15769 | 5152 | 20921 | $0.0044 |
| q11 | verifier | openai-codex/gpt-6-luna:medium | 1 | 0 | 22806 | 4362 | 27168 | $0.0053 |
| q11 | reviewer | openai-codex/gpt-6-luna:high | 1 | 0 | 19687 | 4245 | 23932 | $0.0044 |
