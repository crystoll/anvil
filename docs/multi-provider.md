# Multi-Provider Support (LiteLLM, OpenRouter, etc.)

## Status: Complete

## Overview

Anvil supports multiple LLM providers. Switch between local (Ollama) and remote (LiteLLM,
OpenRouter, or another OpenAI-compatible gateway) models using `provider/model` names. A bare
model name selects a model from the current provider.

## Design

- **Fully-qualified display names**: Models are shown as `provider/model`; a bare model name selects from the current provider
- **No stateful selection**: No numbered lists, no "last listed" tracking
- **Session-scoped**: Provider/model switching persists for the current session only
- **Env var interpolation**: `${ENV_VAR}` syntax in config YAML for endpoints and API keys
- **Backward compatible**: Existing configs work unchanged

## Config

```yaml
default_provider: ollama
default_model: gemma4:e4b
context_size: 32768  # 32k default — increase for large codebases
keep_alive: 30m       # keep native Ollama models loaded between requests
first_token_timeout: 300  # allow model load and prompt evaluation
stream_timeout: 120        # maximum pause between response chunks
connect_timeout: 300       # HTTP connection establishment

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

`keep_alive` is sent to Ollama's native API for streamed and non-streamed requests. It defaults
to `30m`; set it to a duration such as `5m` or a number of seconds accepted by Ollama.

`first_token_timeout` controls how long Anvil waits for a stream's first response chunk;
`stream_timeout` applies to pauses between later chunks. Both are in seconds and default to
`300` and `120`, respectively. `connect_timeout` separately limits connection setup and waiting
for response headers.

## Usage

### List or choose a model (current provider)

In the readline CLI, `/model` lists models. In the TUI, it opens a picker.

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

Change `default_provider` and `default_model` in `~/.anvil/config.yaml` to make a selection the
default for future sessions. `/model` switches only the current session.

```yaml
default_provider: litellm
default_model: ollama/gemma4:e4b
```

### Status bar

The TUI status bar shows the provider and model, such as `ollama/gemma4:e4b`. The readline
status bar shows the model name.

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
