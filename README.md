# Anvil

A personal research project exploring agentic AI development workflows. Yet another AI coding harness — built to learn how they work, not to compete with polished tools like [Plandex](https://github.com/plandex-ai/plandex), [aider](https://github.com/paul-gauthier/aider), or [OpenCode](https://github.com/nicepkg/OpenCode).

Chat with local models, run tools, search the web, use skills — all from TypeScript.

> **Disclaimer**: This is a personal experiment shared for like-minded researchers and tinkerers — not a supported product. It is not superior to existing tools, nor does it aim to be. Local models can be unreliable, slow, or produce nonsensical output. Use at your own responsibility.

## Install Globally

After cloning, build and install as a global binary:

```bash
pnpm install
pnpm build
```

**Option A — symlink (simplest):**

```bash
ln -sf $(pwd)/dist/main.js /usr/local/bin/anvil
```

**Option B — pnpm global link:**

```bash
pnpm link --global .
```

Then run `anvil` from any directory.

To update after code changes: `pnpm build`

## Quick Start

```bash
pnpm install
pnpm dev
```

On first run, creates `~/.anvil/config.yaml` pointing at Ollama on localhost. Then you're chatting:

```
anvil — ollama/gemma4:e4b
Type /quit to exit, /skill to list, /model <name> to switch

you: What files are in this directory?
anvil:
  ↳ list_dir done
Here are the files: ...

you: Search the web for vitest coverage setup
anvil:
  ↳ web_search done
Here are the top results: ...
```

## Commands

| Command             | Description                            |
| ------------------- | -------------------------------------- |
| `/quit`, `/exit`    | Exit                                   |
| `/new`              | Start fresh session                    |
| `/history`          | Browse and load past sessions          |
| `/usage`            | Show session token usage               |
| `/context`          | Show context window + tool token usage |
| `/model <name>`     | Switch model (no arg = list available) |
| `/model @provider`  | List models from another provider      |
| `/model set <name>` | Set default model (persists to config) |
| `/skill <name>`     | Activate a skill (no arg = list all)   |
| `/agent`            | List available agents                  |
| `/rewind N`         | Rewind conversation to turn N          |
| `/plan <task>`      | Generate plan, execute step by step    |
| `/transcript`       | Export session as markdown             |

## CLI Flags

```bash
pnpm dev -- --version               # Show version and exit
pnpm dev -- --simple                # Use readline CLI instead of TUI
pnpm dev -- ~/code/myproject        # Open a specific project directory
pnpm dev -- --model qwen3.6:27b    # Override model
pnpm dev -- --skill code-review     # Start with a skill active
pnpm dev -- --agent explorer        # Use a specific agent config
pnpm dev -- --resume                # Resume last session
pnpm dev -- -c "task description"   # Non-interactive: run task, auto-approve tools, exit
pnpm dev -- --debug                 # Show finish_reason in token display
pnpm dev -- ~/code/project -c "run tests"  # One-shot in a specific directory
```

## Built-in Tools

| Tool              | Approval | Description                         |
| ----------------- | -------- | ----------------------------------- |
| `list_dir`        | auto     | List directory contents             |
| `glob`            | auto     | Find files by pattern               |
| `search`          | auto     | Search file contents                |
| `read_file`       | auto     | Read a file                         |
| `project_context` | auto     | Project overview (deps, git, tree)  |
| `git_status`      | auto     | Git status and branch               |
| `git_diff`        | auto     | Git diff (staged or unstaged)       |
| `git_log`         | auto     | Recent commit history               |
| `web_search`      | auto     | Search the web (DuckDuckGo)         |
| `web_fetch`       | auto     | Fetch URL and extract readable text |
| `write_file`      | y/n      | Write/create a file                 |
| `edit_file`       | y/n      | Edit part of a file                 |
| `run_cmd`         | y/n      | Run a shell command                 |

## Configuration

Global config at `~/.anvil/config.yaml`, created on first run. Change `default_model` to switch models, add providers for remote gateways. See [docs/multi-provider.md](docs/multi-provider.md) for multi-provider setup.

Per-project customization uses agents, skills, and prompts — not a local config file.

### Ollama: Context Size (Required)

> **You must create a model variant with a larger context window.** Ollama defaults to 4096 tokens, which is far too small for agent tool use. Without this step, Anvil will produce empty responses or appear stuck.

```bash
# Create a 128K context variant (uses no extra disk space)
echo 'FROM your-model:tag
PARAMETER num_ctx 131072' | ollama create your-model:tag-128k -f -
```

Then set it as your default in `~/.anvil/config.yaml`:

```yaml
default_model: your-model:tag-128k
```

**Why**: Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) ignores runtime context options. The only reliable way to set context size is to bake it into the model via `ollama create`.

**Symptoms of insufficient context**: empty responses, model stuck after reading files, `finish_reason: length` in debug mode (`--debug`).

## Per-Project Customization

| Feature        | Location           | Description                                                                               |
| -------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| Project prompt | `.anvil/prompt.md` | Persistent context loaded every session                                                   |
| Skills         | `.anvil/skills/`   | [Agent Skills](https://agentskills.io) standard (also `.kiro/skills/`, `.claude/skills/`) |
| Agent configs  | `.anvil/agents/`   | Trust levels, tool guards, hooks — see [docs/hooks.md](docs/hooks.md)                     |
| MCP servers    | `.anvil/mcp.json`  | External tool servers — see [docs/mcp.md](docs/mcp.md)                                    |
| LSP            | `.anvil/lsp.json`  | Language server integration — see [docs/lsp.md](docs/lsp.md)                              |

## Architecture

```
src/
├── provider/   # Stream from any OpenAI-compatible API (Ollama, LM Studio, llama.cpp)
├── engine/     # Chat engine — messages, streaming, cancellation, model switching
├── tools/      # Tool registry + built-in tools (files, shell, web)
├── agent/      # Agent loop — state machine with approval gating and round cap
├── agents/     # Agent configs — loader, discovery, guards, hooks
├── lsp/        # LSP client — TypeScript/Python diagnostics, navigation, auto-inject
├── mcp/        # MCP client — connect to external tool servers (stdio + HTTP)
├── config/     # YAML config loader with validation and defaults
├── session/    # Session persistence (auto-save, resume, history)
├── skills/     # Skill parser + multi-directory discovery
├── web/        # Web search (DuckDuckGo) + fetch (Readability extraction)
├── tui/        # Ink-based terminal UI (default) — status bar, streaming, tool display
├── cli.ts      # Readline-based CLI (--simple fallback)
└── main.ts     # Entry point — routes to TUI or CLI based on flags/environment
```

See [docs/architecture.md](docs/architecture.md) for design details.

## Development

```bash
pnpm install
pnpm dev               # Launch interactive CLI (TUI default)
pnpm build             # Bundle to dist/
pnpm test              # Run unit tests (115 tests)
pnpm check             # Type-check
pnpm lint              # Biome + oxlint
pnpm format            # Biome (code) + dprint (markdown)
```

## Requirements

- Node.js 22+
- pnpm
- Ollama (macOS app or official installer — not Homebrew)

## Documentation

| Doc                                         | Content                                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| [architecture.md](docs/architecture.md)     | Provider layer, agent loop, tool registry, error handling |
| [multi-provider.md](docs/multi-provider.md) | LiteLLM, OpenRouter, remote provider setup                |
| [models.md](docs/models.md)                 | Model benchmarks and recommendations                      |
| [hooks.md](docs/hooks.md)                   | Agent lifecycle hooks and guardrails                      |
| [mcp.md](docs/mcp.md)                       | MCP server configuration (stdio + HTTP)                   |
| [lsp.md](docs/lsp.md)                       | Language server integration and tools                     |
| [ideas.md](docs/ideas.md)                   | Future development ideas                                  |
