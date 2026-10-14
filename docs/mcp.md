# MCP (Model Context Protocol)

Connect external tool servers to Anvil. Any MCP server that supports stdio or HTTP transport works.

## Configuration

Configure in `~/.anvil/mcp.json` (global) or `.anvil/mcp.json` (project-local):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["@bitbonsai/mcpvault@latest", "/path/to/vault"],
      "autoApprove": ["search_notes", "read_note", "get_vault_stats"],
      "connectTimeoutMs": 15000,
      "toolTimeoutMs": 60000
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "remote-docs": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

Anvil also reads `.mcp.json` in your project root for per-project tool servers.

Connection and tool-call timeouts are configurable per server in milliseconds. They default to
15 seconds and 60 seconds, respectively.

Stdio servers inherit a safe subset of Anvil's environment, not the full parent environment. Add
any additional variables a server needs to its `env` object. Server stderr is captured in
`~/.anvil/logs/mcp-<name>.log` so it cannot overwrite the terminal UI.

## Transports

- **stdio** — Spawns server as subprocess, communicates over stdin/stdout (local tools)
- **HTTP** — Connects to remote server via Streamable HTTP (hosted tools)

## Tool Integration

MCP tools appear in the registry prefixed with their server name (e.g., `obsidian.search_notes`). They:

- Require approval by default
- Can be auto-approved per server via the `autoApprove` list
- Respect `allowedTools` in agent configs

## Lifecycle

- **Startup**: Connect to all configured servers concurrently, run initialize handshakes, and list tools
- **Runtime**: Call tools when the agent invokes them
- **Shutdown**: Close all connections gracefully
- **Failure**: If a server fails to connect, show a startup warning and continue with healthy servers

On startup: `MCP: 1 server(s), 15 tools`
