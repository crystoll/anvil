# Multi-Provider Support (LiteLLM, OpenRouter, etc.)

## Status: Complete

## Overview

Anvil supports multiple LLM providers. Switch between local (Ollama) and remote (LiteLLM, OpenRouter, any OpenAI-compatible gateway) models using fully-qualified `provider/model` names.

## Design

- **Fully-qualified names**: Every model is `provider/model` — always explicit, always copy-pasteable
- **No stateful selection**: No numbered lists, no "last listed" tracking
- **Session-scoped**: Provider/model switching persists for the current session only
- **Env var interpolation**: `${ENV_VAR}` syntax in config YAML for endpoints and API keys
- **Backward compatible**: Existing configs work unchanged

## Config

```yaml
default_provider: ollama
default_model: gemma4:e4b
context_size: 32768  # 32k default — increase for large codebases

providers:
  ollama:
    endpoint: http://localhost:11434       # no /v1 → uses native API with context control
    context_size: 131072                   # per-provider override (optional)
  litellm:
    endpoint: http://localhost:4000/v1     # /v1 → OpenAI-compatible
    api_key: ${LITELLM_API_KEY}
  openrouter:
    endpoint: https://openrouter.ai/api/v1
    api_key: ${OPENROUTER_API_KEY}
```

## Usage

### List models (current provider)

```
/model
→ [provider: ollama | active: ollama/gemma4:e4b]
  ollama/gemma4:e4b ●
  ollama/qwen3.6:27b
  ollama/qwen3.6:35b
```

### List another provider's models

```
/model @litellm
→ [provider: litellm | active: ollama/gemma4:e4b]
  litellm/ollama/gemma4:e4b
```

### Switch (copy-paste from list)

```
/model litellm/ollama/gemma4:e4b
→ [model → litellm/ollama/gemma4:e4b]
```

### Switch within current provider (bare name)

```
/model qwen3.6:27b
→ [model → ollama/qwen3.6:27b]
```

### Persist default

```
/model set litellm/ollama/gemma4:e4b
→ [default → litellm/ollama/gemma4:e4b]
```

### Status bar

Always shows fully-qualified: `ollama/gemma4:e4b` or `litellm/ollama/gemma4:e4b`

## Setup: LiteLLM Local

```bash
# Install
pip install 'litellm[proxy]'

# Run proxy pointing at local Ollama
litellm --model ollama/gemma4:e4b

# Add to ~/.anvil/config.yaml:
providers:
  litellm:
    endpoint: http://localhost:4000/v1

# In Anvil:
/model @litellm
/model litellm/ollama/gemma4:e4b
```

## Setup: Remote (with API key)

```bash
# Set env var
export OPENROUTER_API_KEY=sk-or-...

# Config:
providers:
  openrouter:
    endpoint: https://openrouter.ai/api/v1
    api_key: ${OPENROUTER_API_KEY}

# In Anvil:
/model openrouter/anthropic/claude-sonnet-4
```

## Setup: llama.cpp Server

llama.cpp's built-in HTTP server exposes an OpenAI-compatible API with tool calling, reasoning support, and model metadata. Anvil has a dedicated provider that adds health checking and context size auto-detection.

### Starting the server

```bash
# Basic — loads model with 64k context
llama-server -m model.gguf -c 65536

# With tool calling (required for agent mode)
llama-server -m model.gguf -c 65536 --jinja

# With an alias (shows as model name in Anvil)
llama-server -m model.gguf -c 65536 --jinja --alias qwen3:8b

# From Hugging Face (auto-downloads)
llama-server -hf ggml-org/Qwen3-8B-GGUF:Q4_K_M -c 65536 --jinja
```

### Config

```yaml
default_provider: llamacpp
default_model: qwen3:8b  # must match --alias or the model path/id

providers:
  llamacpp:
    endpoint: http://localhost:8080
```

The provider name (`llamacpp`, `llama.cpp`, or `llama-cpp`) triggers the dedicated provider. It auto-appends `/v1` internally — don't add it to the endpoint.

### How it works

- Streaming and completions go through the standard `/v1/chat/completions` endpoint
- `checkHealth` hits `/health` to detect if the model is still loading
- `fetchContextSize` reads `n_ctx_train` from `/v1/models` metadata
- Tool calling requires the server to be started with `--jinja`
- Reasoning models work with `--reasoning-format deepseek`

### Key differences from Ollama

|                 | Ollama                  | llama.cpp                         |
| --------------- | ----------------------- | --------------------------------- |
| Context size    | Per-request (`num_ctx`) | Set at server launch (`-c`)       |
| Model switching | Built-in multi-model    | Restart server or use router mode |
| Model listing   | All pulled models       | Only loaded model(s)              |
| Tool calling    | Native                  | Requires `--jinja` flag           |

### Context size

Unlike Ollama, llama.cpp does not support per-request context size override. The context is fixed at server launch via `-c N`. Anvil's `context_size` config is used only for overflow detection — the actual context is whatever you passed to `llama-server`.

If you want to use a specific context size, launch the server accordingly:

```bash
llama-server -m model.gguf -c 131072 --jinja  # 128k context
```

## Known Limitations

- LiteLLM streaming may not always produce structured `tool_calls` chunks for some model/provider combinations. Direct Ollama is most reliable for tool calling.
- When LiteLLM has a master key configured, the `api_key` field is required.
