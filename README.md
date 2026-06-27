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
ln -sf $(pwd)/dist/cli.js /usr/local/bin/anvil
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

## Skills

Anvil supports the [Agent Skills](https://agentskills.io) standard — compatible with Kiro and Claude skills.

Skills are discovered from (project-local first, then global):

- `.anvil/skills/`, `.kiro/skills/`, `.claude/skills/` (in project)
- `~/.anvil/skills/`, `~/.kiro/skills/`, `~/.claude/skills/` (global)

Create a skill: `mkdir -p .anvil/skills/my-skill && cat > .anvil/skills/my-skill/SKILL.md`

```yaml
---
name: my-skill
description: When to activate this skill
---

Instructions for the agent when this skill is active.
```

## Configuration

Created automatically on first run at `~/.anvil/config.yaml`:

```yaml
default_provider: ollama
default_model: gemma4:e4b      # change this to switch your default
stream_timeout: 30
connect_timeout: 30
max_rounds: 25

providers:
  ollama:
    endpoint: http://localhost:11434/v1
```

## Project Prompt

Place a `.anvil/prompt.md` in your project root to provide persistent context to the agent (project description, conventions, etc). Loaded automatically on every session.

## Architecture

```
src/
├── provider/   # Stream from any OpenAI-compatible API (Ollama, LM Studio, llama.cpp)
├── engine/     # Chat engine — messages, streaming, cancellation, model switching
├── tools/      # Tool registry + built-in tools (files, shell, web)
├── agent/      # Agent loop — state machine with approval gating and round cap
├── agents/     # Agent configs — loader, discovery, guards, hooks
├── lsp/        # LSP client — TypeScript/Python diagnostics, navigation, auto-inject
├── mcp/        # MCP client — connect to external tool servers (stdio transport)
├── config/     # YAML config loader with validation and defaults
├── session/    # Session persistence (auto-save, resume, history)
├── skills/     # Skill parser + multi-directory discovery
├── web/        # Web search (DuckDuckGo) + fetch (Readability extraction)
├── tui/        # Ink-based terminal UI (default) — status bar, streaming, tool display
├── cli.ts      # Readline-based CLI (--simple fallback)
└── main.ts     # Entry point — routes to TUI or CLI based on flags/environment
```

## Agent Configs

Define agent profiles with different trust levels in `.anvil/agents/`:

```yaml
# .anvil/agents/default.yaml
name: default
description: Standard agent with guardrails
tools:
  - "*"
allowedTools:
  - list_dir
  - glob
  - search
  - read_file
  - web_search
  - web_fetch
toolSettings:
  read_file:
    deniedPaths: ["~/.ssh/**", "~/.aws/**", "**/.env*"]
  write_file:
    allowedPaths: ["./**"]
    deniedPaths: ["~/.ssh/**", "/etc/**"]
  run_cmd:
    deniedCommands: ["rm -rf.*", "sudo.*", "git (push|merge|reset).*"]
hooks:
  sessionStart:
    - command: "bash ~/.anvil/hooks/notify.sh"
  stop:
    - command: "bash ~/.anvil/hooks/notify.sh"
      async: true
  preToolUse:
    - command: "bash ~/.anvil/hooks/guardrail.sh"
      matcher: "run_cmd"
      timeout: 3
```

Agents are discovered from `.anvil/agents/` (project-local, then `~/.anvil/agents/` global).

## MCP (Model Context Protocol)

Connect external tool servers to Anvil. Any MCP server that supports stdio transport works — Obsidian, Playwright, databases, etc.

Configure in `~/.anvil/mcp.json` (global) or `.anvil/mcp.json` (project-local):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["@bitbonsai/mcpvault@latest", "/path/to/vault"],
      "autoApprove": ["search_notes", "read_note", "get_vault_stats"]
    },
    "remote-docs": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

Supports both stdio (local subprocess) and HTTP (remote server) transports. Anvil also reads `.mcp.json` in your project root (Claude Code compatible).

MCP tools appear in the registry prefixed with their server name (e.g., `obsidian.search_notes`). They require approval by default unless listed in `autoApprove`. The `allowedTools` field in agent configs applies to MCP tools too.

On startup: `MCP: 1 server(s), 15 tools`

## LSP (Language Server Protocol)

Anvil integrates with language servers for code intelligence. After edits, diagnostics are automatically injected into tool results — the model sees type errors immediately and can self-correct.

Configure in `.anvil/lsp.json` (project) or `~/.anvil/lsp.json` (global). Also reads `.kiro/settings/lsp.json`:

```json
{
  "languages": {
    "typescript": {
      "name": "typescript-language-server",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "file_extensions": ["ts", "js", "tsx", "jsx", "mjs", "cjs"],
      "project_patterns": ["package.json", "tsconfig.json"],
      "exclude_patterns": ["**/node_modules/**", "**/dist/**"]
    },
    "python": {
      "name": "basedpyright",
      "command": "basedpyright-langserver",
      "args": ["--stdio"],
      "file_extensions": ["py", "pyi"],
      "project_patterns": ["pyproject.toml", "setup.py", "requirements.txt"],
      "exclude_patterns": ["**/__pycache__/**", "**/.venv/**", "**/venv/**"]
    }
  }
}
```

Install language servers: `npm i -g typescript-language-server typescript` and `pipx install basedpyright`

LSP tools (all auto-approve, read-only):

| Tool              | Description                            |
| ----------------- | -------------------------------------- |
| `lsp_diagnostics` | Errors/warnings for a file             |
| `lsp_definition`  | Go to definition of symbol at position |
| `lsp_references`  | Find all usages of symbol              |
| `lsp_hover`       | Type info and docs at position         |
| `lsp_symbols`     | List all symbols in a file             |
| `lsp_rename`      | Rename symbol across files (y/n)       |

On startup: `LSP: configured`

## File History

Before `write_file` or `edit_file` modifies an existing file, the original is backed up to `.anvil/file-history/<path>/<timestamp>`. This provides an undo safety net for agent writes. New files (first creation) are not backed up.

## Token Usage

Token usage is tracked per-turn and per-session:

- After each response: `[1220→32 tok]` (prompt → completion)
- On `/quit`: `Session: 1252 tokens (1220 prompt)`
- On demand: `/usage` command
- Persisted in session JSON for historical tracking

Configure with `show_tokens: false` in `config.yaml` to hide per-turn display.

## Development

```bash
pnpm install
pnpm dev               # Launch interactive CLI (TUI default)
pnpm build             # Bundle to dist/
pnpm test              # Run unit tests (110 tests)
pnpm check             # Type-check
pnpm lint              # Biome + oxlint
pnpm format            # Biome (code) + dprint (markdown)
```

## Requirements

- Node.js 22+
- pnpm
- Ollama (macOS app or official installer — not Homebrew)

## What's Next

- Scheduling and workflow chains
- Multi-pane terminal UI (Ink)
