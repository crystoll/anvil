# Architecture

## Overview

```
src/
├── provider/   # LLM provider abstraction — OpenAI-compatible streaming
├── engine/     # Chat engine — messages, streaming, cancellation, model switching
├── agent/      # Agent loop — state machine with approval gating and round cap
├── agents/     # Agent configs — loader, discovery, guards, hooks
├── tools/      # Tool registry + built-in tools (files, shell, web, git)
├── config/     # YAML config loader with validation and defaults
├── session/    # Session persistence (auto-save, resume, history)
├── skills/     # Skill parser + multi-directory discovery
├── lsp/        # LSP client — diagnostics, navigation, auto-inject after edits
├── mcp/        # MCP client — connect to external tool servers (stdio + HTTP)
├── web/        # Web search (DuckDuckGo) + fetch (Readability extraction)
├── tui/        # Ink-based terminal UI (default) — status bar, streaming, tool display
├── cli.ts      # Readline-based CLI (--simple fallback)
└── main.ts     # Entry point — routes to TUI or CLI based on flags/environment
```

## Provider Layer

All providers use the OpenAI-compatible chat completions API. A single implementation covers Ollama, LM Studio, llama.cpp, and any compatible endpoint.

```typescript
type StreamChunk = {
  content?: string
  reasoning?: string
  toolCall?: ToolCallDelta
  done: boolean
  usage?: { promptTokens: number; totalTokens: number }
}
```

Robustness:

- Stream timeout — abort if no chunk arrives within configured seconds
- Connection timeout — accounts for model cold-loading
- Partial tool call recovery — lenient JSON parsing for incomplete output
- Empty response detection — retry once before reporting failure
- Graceful degradation — never hang, every await has a timeout

## Agent Loop

Sequential state machine for tool-using interactions:

```
idle → streaming → pending → executing → streaming → ...
                          ↘ done/stuck → idle
```

- **Round cap**: Maximum iterations per turn (default 25)
- **Approval gating**: Side-effecting tools require user confirmation
- **Read-only tools auto-execute**: `list_dir`, `glob`, `search`, `read_file`
- **Retry on malformed tool calls**: Send error back to model, let it retry

## Tool Registry

Tools are registered with a schema, approval requirement, timeout, and execute function. Built-in tools cover file operations, shell, git, and web. MCP tools are merged into the same registry at runtime.

```typescript
type Tool = {
  name: string
  description: string
  schema: JsonSchema
  needsApproval: boolean
  timeout: number
  execute: (args: unknown, projectRoot: string) => ResultAsync<string, ToolError>
}
```

## Agent Configs

YAML definitions in `.anvil/agents/` control tool access, auto-approval, path guards, command regex filters, and lifecycle hooks per agent profile.

## Error Handling

All fallible operations return `Result<T, E>` or `ResultAsync<T, E>` (neverthrow). No thrown exceptions in business logic. Errors are typed discriminated unions.

## Configuration

YAML config at `~/.anvil/config.yaml` — provider endpoints, default model, timeouts, context size, and display preferences. Created automatically on first run.
