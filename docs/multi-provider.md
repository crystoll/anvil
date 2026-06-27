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

providers:
  ollama:
    endpoint: http://localhost:11434/v1
  litellm:
    endpoint: http://localhost:4000/v1
    api_key: ${LITELLM_API_KEY}    # resolved from environment
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

## Known Limitations

- LiteLLM streaming may not always produce structured `tool_calls` chunks for some model/provider combinations. Direct Ollama is most reliable for tool calling.
- When LiteLLM has a master key configured, the `api_key` field is required.
