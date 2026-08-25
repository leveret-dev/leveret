# Leveret replay summary

Generated mechanically from runner JSON. Semantic finding overlap and defect validity are intentionally not inferred.

| run | findings | actionable | priced-noise | false-positive | dropped | tool calls | errors | timeouts | diff calls | diff bytes | detail | correction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 2026-08-25-parity-rerun-pf2444-summary | 4 | 4 | 0 | 0 | 0 | 85 | 2 | 0 | 4 | 1319788 | complete | no |
| 2026-08-25-parity-rerun-pf2521-summary | 2 | 2 | 24 | 0 | 0 | 85 | 4 | 0 | 2 | 2155836 | complete | no |

## 2026-08-25-parity-rerun-pf2444-summary

- Model: `openai-codex/gpt-5.6-sol` (high)
- System prompt: `2 / 7e7732b5e0f26153acf92d9a2b6b7ff929aa9da70fd761a0f7e0654ab876e4a0`
- Coverage: considered-fine=5, findings=10

### Published findings

- **[major]** `scripts/gen_landing.py:500` — installer one-liner masks fetch failures (R1)
- **[major]** `scripts/channel-install/install-common.sh:133` — cwd-relative hook overrides the embedded trusted hook (R2)
- **[major]** `scripts/channel-install/install-common.sh:180` — stale marker lets failed conf regeneration pass (R3)
- **[major]** `scripts/channel-install/install-common.sh:305` — payload verification succeeds when pkg info fails (R4)

## 2026-08-25-parity-rerun-pf2521-summary

- Model: `openai-codex/gpt-5.6-sol` (high)
- System prompt: `2 / 7e7732b5e0f26153acf92d9a2b6b7ff929aa9da70fd761a0f7e0654ab876e4a0`
- Coverage: considered-fine=63, findings=9

### Published findings

- **[major]** `scripts/smoke-on-box.sh:418` — on-box smoke images are never removed after the workload (R1)
- **[major]** `pyproject.toml:10` — the derived Python matrix cannot run a non-3.11 leg (R2)
