# Model Recommendations

Tested with `scripts/model-test.ts` — 4 tasks per model: simple Q&A, single tool use, multi-step tool chain (Obsidian vault), and LSP write-and-fix loop.

## Summary

| Model           | Size | Architecture | Avg Time | Completion Tokens | Reliability |
| --------------- | ---- | ------------ | -------- | ----------------- | ----------- |
| **gemma4:e4b**  | 8GB  | MoE          | **19s**  | 1332              | 4/4 ✅      |
| **qwen3.6:35b** | 22GB | MoE          | **17s**  | 871               | 4/4 ✅      |
| qwen3.6:27b     | 16GB | Dense        | 66s      | 878               | 4/4 ✅      |
| qwen3-agentic   | 8GB  | Dense        | 70s      | 2951              | 4/4 ✅      |

## Recommendations

### Default: `gemma4:e4b`

Best all-rounder for daily use:

- Fast (19s average across all task types)
- Reliable tool calling — chains search → read → analyze without issues
- Compact output — doesn't over-explain
- Self-corrects with LSP feedback
- Low memory footprint (8GB)

### Power: `qwen3.6:35b`

Fastest overall (17s avg) despite being largest:

- MoE architecture — only activates subset of parameters per token
- Most token-efficient (871 total completion tokens across 4 tasks)
- Excellent for complex tasks where quality matters
- Requires 22GB VRAM

### Deep reasoning: `qwen3.6:27b`

Most capable per-parameter but slow:

- Dense architecture — all 27B params active per token
- 3-4x slower than MoE models (66s average)
- Same output quality as 35b for these tasks
- Use when you need maximum reasoning but aren't time-constrained

### Avoid for agentic work: `qwen3-agentic`

Despite the name, not ideal:

- Extremely verbose (2951 completion tokens — 3x more than others)
- Slow (70s average)
- Works correctly but wastes tokens on explanations
- May be better for single-shot generation, not tool loops

## Observations

- **All models reliably chain tools.** The MCP Obsidian search → read pipeline works across all tested models.
- **LSP feedback loop works.** All models detect diagnostics and attempt fixes. `gemma4:e4b` uses a clean pattern: write → check diagnostics → rewrite.
- **MoE models are faster.** Both gemma4:e4b (8GB) and qwen3.6:35b (22GB) use MoE, explaining their speed advantage over dense models.
- **Token efficiency correlates with quality.** Models that produce fewer tokens tend to give more focused, actionable responses.

## Running Tests

```bash
# Test all Ollama models:
tsx scripts/model-test.ts

# Test specific models:
tsx scripts/model-test.ts gemma4:e4b qwen3.6:35b
```

## Hardware

Tested on macOS with Apple Silicon. All models served via Ollama. Times include cold-start (first model load ~5-10s extra, subsequent runs faster).
