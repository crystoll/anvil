# Future Development Ideas

All items are potential work — not confirmed. Prioritized by value and effort.

## Priority 1 — Daily UX Improvements

### LiteLLM / remote model support

Support invoking models via LiteLLM proxy or any remote OpenAI-compatible gateway with API key auth.

- **Approach**: Already works at provider level (OpenAI-compatible API), but needs:
  - Multiple providers in config (not just one default)
  - API key management (per-provider `apiKey` field, env var fallback)
  - `/model` listing that queries the remote provider's model list endpoint
  - Seamless switching between local (Ollama) and remote (LiteLLM, OpenRouter, etc.) models
- **Config example**:
  ```yaml
  providers:
    ollama:
      endpoint: http://localhost:11434/v1
    litellm:
      endpoint: https://my-proxy.example.com/v1
      apiKey: ${LITELLM_API_KEY}
  ```
- **Scope**: Config schema extension, provider switching in `/model`, env var interpolation for keys. Medium effort.

## Priority 2 — Code Quality

### DRY pass

Extract shared logic between `cli.ts` (~870 lines) and `tui/app.tsx` (~450 lines).

- **Targets**: Flag parsing, bootstrap (provider/engine/registry/agent creation), `expandFileRefs`, `buildMcpHint`, command dispatch.
- **Approach**: Extract into `src/shared/` modules. Both UIs become thin shells.
- **Risk**: Over-abstraction. Keep it to obvious duplication only.

## Priority 3 — Tooling & CI

### Renovate

Automated dependency update PRs via GitHub Actions.

- **Approach**: Add `renovate.json` with: group minor/patch, require CI pass, auto-merge patch, manual merge minor/major.
- **Value**: Catches security updates, prevents drift.
- **Scope**: Config file only, no code changes.

## Deferred / Future Investigations

### Multi-pane layout

Split terminal into conversation pane + tool output/status pane.

- **Status**: Needs design and prototyping. Full project, not a feature.
- **Value**: Keeps tool results visible without scrolling.

### Remote control via Discord/Slack

Headless daemon mode + message bridge for remote interaction.

- **Status**: Exploratory. Security concerns. SSH + tmux already covers remote access.

### Internal task/todo tracking

Agent-side step tracking for multi-step operations.

- **Status**: `/plan` command partially covers this. Evaluate after more real usage.
