# Hooks

Shell commands triggered at specific lifecycle points. Use cases: notifications, guardrails, and external integrations.

## Lifecycle Events

| Event          | When                                | Blocking | Use case                   |
| -------------- | ----------------------------------- | -------- | -------------------------- |
| `sessionStart` | Agent session begins                | No       | Start tracking, announce   |
| `preToolUse`   | Before any tool executes            | **Yes**  | Guardrails, validation     |
| `postToolUse`  | After tool execution completes      | No       | Logging, notifications     |
| `stop`         | Agent turn ends (response complete) | No       | Completion sounds, cleanup |

## Configuration

Hooks are defined per-agent in the agent config:

```yaml
# .anvil/agents/default.yaml
hooks:
  sessionStart:
    - command: "bash ~/.anvil/hooks/notify.sh"
      timeout: 5
  preToolUse:
    - command: "bash ~/.anvil/hooks/guardrail.sh"
      timeout: 3
      matcher: "run_cmd"
  postToolUse:
    - command: "bash ~/.anvil/hooks/peon-ping.sh"
      timeout: 5
      async: true
  stop:
    - command: "bash ~/.anvil/hooks/peon-ping.sh"
      timeout: 5
      async: true
```

## Hook Definition Fields

| Field     | Required | Default | Description                                 |
| --------- | -------- | ------- | ------------------------------------------- |
| `command` | Yes      | —       | Shell command to execute                    |
| `timeout` | No       | 5       | Max seconds before kill                     |
| `matcher` | No       | —       | Only fire for specific tool name            |
| `async`   | No       | false   | Fire-and-forget (don't wait for completion) |

## Protocol

Hooks receive JSON on **stdin** with event context:

```json
{
  "hook_event_name": "preToolUse",
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "tool_name": "run_cmd",
  "tool_args": { "command": "npm test" }
}
```

For `preToolUse`, a non-zero exit code denies execution. Stdout is used as the denial reason fed back to the model.

## Execution Model

- **Sync hooks** (default): Run sequentially, await completion
- **Async hooks** (`async: true`): Spawned and detached, no exit code checked
- **Timeout**: Hook killed with SIGTERM after timeout. For blocking hooks, timeout = deny
- **Matcher**: If set, hook only fires when `tool_name` matches
