# LSP Integration

Language server integration provides code intelligence to the agent. After edits, diagnostics are automatically injected into tool results — the model sees type errors immediately and can self-correct.

## Tools

| Tool              | Approval | Description                            |
| ----------------- | -------- | -------------------------------------- |
| `lsp_diagnostics` | auto     | Errors/warnings for a file             |
| `lsp_definition`  | auto     | Go to definition of symbol at position |
| `lsp_references`  | auto     | Find all usages of symbol              |
| `lsp_hover`       | auto     | Type info and docs at position         |
| `lsp_symbols`     | auto     | List all symbols in a file             |
| `lsp_rename`      | y/n      | Rename symbol across files             |

## Auto-Inject After Edits

When `write_file` or `edit_file` modifies a file the LSP knows about, diagnostics are automatically requested and appended to the tool result:

```
File written successfully.

⚠ 2 diagnostics:
  line 15: error TS2345: Argument of type 'string' is not assignable...
  line 23: warning TS6133: 'unused' is declared but its value is never read.
```

The model sees errors in the same turn and can fix immediately.

Diagnostics are best-effort: failed edits get none, and a server that takes longer than 3 s never holds up the tool result.

## Configuration

Stored in `.anvil/lsp.json` (project) or `~/.anvil/lsp.json` (global):

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
      "exclude_patterns": ["**/__pycache__/**", "**/.venv/**"]
    }
  }
}
```

## Requirements

- TypeScript: `npm i -g typescript-language-server typescript`
- Python: `pipx install basedpyright`

Language servers are started lazily on first relevant file operation and kept warm for the session.

If a server can't start (for example, it isn't installed), anvil prints one `⚠ LSP unavailable: …` notice and carries on without it, and the `lsp_*` tools report the error to the model. Requests that get no answer time out after 10 s (30 s for startup).
