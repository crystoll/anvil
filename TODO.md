# TODO — Robustness, interrupts, persistence, dependency refresh

Roadmap from the 2026-10-14 review. The goal is to make anvil dependable with **slow, small local models** (Ollama). In order:

1. No hangs.
2. No lost sessions.
3. Clean interrupts.
4. Honest errors.
5. Then usefulness improvements and up-to-date dependencies.

Baseline at review time:

- 178 tests pass; `pnpm lint` and `pnpm check` are green.
- The CI audit gate is red: `pnpm audit --audit-level=critical --prod` exits 1 (see F13).

## How to work this list

- **One milestone at a time.** Each ends with a **validation stop**. Don't start the next milestone until it's green.
- **TDD for every item.** Write the **Test first** case, watch it fail, implement, watch it pass, refactor. Each test is described in enough detail to write directly as a Vitest test.
- **Surgical changes that follow `CLAUDE.md`**: neverthrow `Result`, remeda, functions of 20 lines or fewer, cognitive complexity of 15 or less, `exactOptionalPropertyTypes`.
- **Commits:** one per checkbox where practical, using the existing prefixes (`fix:`, `feat:`, `chore:`).
- **Docs:** update in the same milestone that changes the behavior.

### Gate (mirrors CI)

```bash
pnpm install --frozen-lockfile
pnpm audit --audit-level=critical --prod
pnpm lint && pnpm check && pnpm build && pnpm test
pnpm test:integration   # from M5 on (mock-server and e2e suites)
pnpm exec dprint check  # when Markdown changed
```

### Manual smoke checks (local Ollama, isolated home)

Run with `HOME=/tmp/anvil-test-home pnpm dev`, after copying `~/.anvil/config.yaml` into that home. Each validation stop lists the checks it needs.

| ID | Scenario                                                                       | Expected                                                              |
| -- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| S1 | Ask for a long answer, press Esc mid-stream (TUI and CLI)                      | `[interrupted]` within 1 s; the next message is answered normally     |
| S2 | "Read package.json, run `git status`, then read README.md", approve            | All 3 tool results recorded; model continues; no HTTP 400 via LiteLLM |
| S3 | In this repo (LSP binary missing): "create src/smoke.ts with a hello function" | Completes in seconds with a single "LSP unavailable" notice           |
| S4 | Mid-turn `kill <pid>` from another terminal, restart with `--resume`           | History intact up to the last committed message; next message works   |
| S5 | Long session past compaction while watching `ollama ps`                        | No model reload during compaction; context stays below `num_ctx`      |
| S6 | `/quit`, or double Ctrl+C while idle                                           | Exits within 2 s; session saved; terminal restored                    |

## Decisions

Agreed:

- **TUI vs readline CLI:** extract a shared **headless session controller**; both UIs become thin views (M8).
- **MCP:** migrate to `@modelcontextprotocol/client` v2 (M1).
- **Dependencies:** upgrade everything, including majors, one validated step at a time.
- **Safety hardening:** included (M11).

Defaults chosen here; change them if you disagree:

- **Partial answers.** On interrupt or error, the partial text stays in history labeled `status: "interrupted"` or `status: "error"`, and is never presented as complete. Incomplete tool calls are dropped. `/retry` removes the partial and re-runs the turn.
- **Reminders.** Round and goal reminders are request-only (not persisted). Give-up nudges stay persisted but are marked `synthetic`, so UIs and compaction can hide them.

## What the review found

Legend: ✅ reproduced against current code · 📊 seen in `~/.anvil/history` (67 sessions) · 🔍 code reading

- **F1. Interrupting a streaming answer swallows the next message.** ✅ 📊
  - `cancel()` sets `cancelled` in `loop.ts`, but a turn that ends via the idle path never clears it. The next `send()` then returns without calling the model.
  - 5 real sessions end on an unanswered user message, and 4 contain duplicated consecutive user messages.
  - Fixed in M3.4 and M6.1.
- **F2. Ollama stream failures pass as success.** ✅ A socket drop, a `{"error": …}` line (runner crash) or a mid-stream stall ends the stream **silently**, and the partial text is saved as a complete answer. Fixed in M5.
- **F3. User aborts are mishandled.** ✅ 🔍 Ollama's `readStream` swallows the abort; openai-compatible reports it as "Connection timed out". Fixed in M5.
- **F4. A missing LSP server hangs the agent.** ✅
  - `.anvil/lsp.json` points at `typescript-language-server`, which isn't installed.
  - After any successful `.ts` write, the agent **hangs forever** in "executing". Cancel can't help, and the unsaved session is lost on kill.
  - LSP `initialize`, requests and `shutdown()` have no timeouts, so exit can hang too.
  - Fixed in M3.1 and M3.2.
- **F5. Failed edits crash the TUI.** ✅ The diagnostic injector also runs on _failed_ edits and rejects with ENOENT. Nothing handles the rejection in the TUI approval path, so the app **crashes**. Fixed in M3.2 and M3.6.
- **F6. Mid-message approvals orphan tool calls.** ✅
  - An approval in the middle of a multi-tool message leaves the later calls **unanswered**.
  - The next request carries 3 `tool_calls` but only 2 results, so strict servers (LiteLLM → Gemini/OpenAI) return HTTP 400.
  - Fixed in M6.2.
- **F7. Cancel doesn't stop tools.** ✅ The running tool and the remaining tools keep going; `run_cmd` can block for up to 300 s. Fixed in M7.
- **F8. TUI stale closures break approvals.** 🔍 📊 `sendMessage` and `handleApproval` read a render-time `pendingTool`.
  - When a turn stops for approval with no text, the TUI auto-sends "Please try again." on top of the pending tool call. This happened 10 times in 8 sessions, 6 of them right after a pending approval.
  - After an approval, `busy` is never set. Ctrl+C then exits instead of cancelling, input is accepted mid-generation, and the post-turn `save()` never runs.
  - Fixed in M3.5 and M8.
- **F9. Sessions are easy to lose.** 📊
  - Sessions are saved only at turn end, with a non-atomic `writeFileSync`.
  - There is no SIGTERM or SIGHUP handling, and `/quit` calls `process.exit(0)` without saving or shutting down.
  - 13 of 67 sessions (19 %) ended mid-turn, leaving 66 orphaned tool-call IDs across 11 sessions.
  - Fixed in M3 and M4.
- **F10. `edit_file` corrupts `$` patterns.** ✅ It uses `String.replace`, so `$&`, `$$` and `$1` in the replacement get interpreted. Fixed in M3.7.
- **F11. Compaction forces Ollama model reloads.** 🔍
  - Compaction calls `completeChat` without `num_ctx`, and `temperature` and `maxTokens` never reach Ollama `options`.
  - Ollama's `needsReload` (`server/sched.go`) sees different runner options. Each compaction then costs **two full model reloads** (24 GB for `qwen3.6:35b`) and gets a truncated summary input.
  - Fixed in M10.1.
- **F12. Cancel isn't awaited.** 🔍 The UIs go idle while the generator still runs, so a quick follow-up races the shared engine ("Already streaming"). The engine also lacks a `finally` reset. Fixed in M5.3, M6.1 and M8.
- **F13. The CI audit gate fails today.** ✅
  - A critical `proxy-addr` advisory arrives via `@modelcontextprotocol/sdk` → express.
  - Production dependencies have 19 advisories: 1 critical, 6 high and 12 moderate.
  - The last green CI run (2026-08-17) predates the advisory.
  - Fixed in M0.1 and M1.
- **F14. Safety gaps.** 🔍
  - `-c` one-shot mode auto-approves **every** tool, including `run_cmd` and `write_file`.
  - `read_file` accepts absolute and `~` paths, and `web_fetch` is auto-approved, which together give prompt injection a way to exfiltrate data.
  - Fixed in M11.
- **F15. MCP servers misbehave.** 🔍
  - Stdio servers inherit stderr, so their logs draw over the TUI.
  - Connects run sequentially and errors are swallowed.
  - When `env` is set, the full `process.env` (API keys) is passed to the server.
  - Fixed in M1.
- **F16. Esc doesn't interrupt the TUI.** 🔍 The README promises it, but Esc only works in the readline CLI and in pickers. Fixed in M6.1.
- **F17. Readline CLI bugs.** 🔍
  - Retry duplicates the user message.
  - A second pending tool call is dropped.
  - The approval preview reads `old_text`/`new_text`, but the schema uses `search`/`replace`.
  - Fixed in M8.
- **F18. Mid-session switches only half apply.** 🔍
  - The loop receives its system prompt, provider and `contextSize` once, at boot.
  - After `/model` moves to another provider, compaction still calls the boot provider with the new model name. Trimming, overflow detection and tool budgets keep the boot `contextSize`.
  - `/skill` and `/agent` never reach the system prompt; `/agent` only changes the tool set.
  - Fixed in M6.9.
- **F19. `run_cmd` misreports failures.** ✅
  - Output over 1 MB kills the command (`execFile`'s default `maxBuffer`) and reports `Exit code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
  - A timeout reports `Exit code: null`.
  - Only the first 8,000 characters are kept, so errors at the end of long output are lost.
  - Fixed in M7.2 and M10.9.
- **F20. Closing the readline CLI skips shutdown.** ✅ Ctrl+C or Ctrl+D at any prompt closes readline, but Node never settles a pending `question()`. The process dies with exit code 13 and a "Detected unsettled top-level await" warning, and `ctx.shutdown()` never runs. Fixed in M3.12.
- **F21. The readline CLI drops input that arrives during a turn.** ✅ Readline hands each line to a pending `question()` and otherwise emits a `'line'` event, which nothing listens to. A prompt typed while the model works is echoed into the answer, then lost. Piped input runs only its first prompt, and its closing `/quit` is lost too. The TUI keeps the text in its input box. Fixed in M8.2.

## Milestones

| Milestone                                | Est.  | Depends on        | Priority |
| ---------------------------------------- | ----- | ----------------- | -------- |
| M0 Unblock CI, hygiene, safe minors      | 0.5 d | none              | P0       |
| M1 MCP client v2 migration               | 1 d   | M0                | P0       |
| M2 Test tooling majors (Vitest 5, MSW 3) | 0.5 d | M0                | P1       |
| M3 Stop the hangs and crashes            | 1.5 d | M0 (M2 preferred) | P0       |
| M4 Never lose a session                  | 1 d   | M3                | P0       |
| M5 Honest streams                        | 1.5 d | M2                | P0       |
| M6 Agent loop integrity                  | 2 d   | M5                | P0       |
| M7 Cancellation all the way down         | 1.5 d | M6                | P1       |
| M8 Shared session controller, thin UIs   | 4 d   | M4, M6, M7        | P1       |
| M9 ink 8 and rendering                   | 1 d   | M8                | P2       |
| M10 Small-model ergonomics               | 3.5 d | M5, M6            | P1       |
| M11 Safety hardening                     | 1.5 d | M7                | P1       |
| M12 Persistence UX                       | 1.5 d | M4, M8            | P2       |
| M13 CI and maintenance                   | 0.5 d | M1, M2            | P2       |

The total is about 21.5 focused days.

- Suggested order for one person: M0, M2, M3, M4, M1, M5, M6, M7, M8, then M10, M11, M9 and M12. This puts the hang, crash and session-loss fixes first. M13 fits anywhere after M1 and M2.
- The longest dependency chain is M0 → M2 → M5 → M6 → M7 → M8 → M12 (11.5 d). M1, M3 and M4 can run alongside it.
- M10.1 (Ollama options, about 3 h) can be pulled forward at any time.

---

## M0 — Unblock CI, hygiene, safe minors (0.5 d)

- [x] **M0.1 Clear the critical advisory now.** Add the override `proxy-addr: '>=2.0.8'` to `pnpm-workspace.yaml`.
  - Express 5.2.1 accepts `^2.0.7`, and 2.0.8 was published on 2026-09-15.
  - Confirm with `pnpm why proxy-addr`.
  - This is interim: M1 removes express entirely.
- [x] **M0.2 Remove the self-dependency.** Delete `"anvil": "link:"` from `package.json` and `anvil: 'link:'` from the overrides. Nothing imports `anvil`.
- [x] **M0.3 Pin the toolchain.**
  - Add `"packageManager": "pnpm@12.11.2"`. Local pnpm is 12.3.4; CI pins 11.
  - Drop `version: 11` from CI so pnpm/action-setup reads the field.
  - Keep `engines.node` at `>=22`.
  - Done. pnpm 12 also pins its own binaries in a first document in `pnpm-lock.yaml`.
- [x] **M0.4 Patch and minor bumps,** one commit each, running the gate after each. Done in three commits (lint tools, runtime dependencies, dev tools), with the gate after each. The dprint Markdown plugin also went from 0.17.8 to 0.26.0 with no Markdown diffs, and oxlint 1.87 flagged one unused binding (fixed).
  - `@biomejs/biome` 2.5.15, then `pnpm biome migrate --write` for the `$schema`.
  - `js-yaml` 5.4.3 (moderate advisory).
  - `remeda` 2.51.0 and `linkedom` 0.18.13.
  - `react` and `@types/react` 19.3.0 (prerequisite for ink 8).
  - `oxlint` 1.87.0 (fix any new findings), `tsx` 4.23.15 and `vite` 8.3.4.
  - `dprint` 0.62.0 (review the Markdown diffs).
  - `vitest` 4.1.11+ (moderate advisory; stepping stone to v5).
- [x] **M0.5 Align `@types/node` with the runtime floor.** It's 26.2.0 while CI runs Node 22, so typecheck accepts APIs that are missing at runtime. Align it to `^22` (22.20.5), or raise both floors to 24. Done: pinned 22.20.5; `tsc` found no Node 24+ APIs.
- [x] **M0.6 Make the supply-chain guard explicit.** Add `minimumReleaseAge: 1440` to `pnpm-workspace.yaml`. It's already the default since pnpm 11; this documents the intent.

**Validation stop:**

1. The full gate passes, including `pnpm audit --audit-level=critical --prod` exiting 0.
2. Push and see CI go green.

## M1 — MCP client v2 migration (1 d)

**Why:** this clears the critical advisory and most of the highs.

- v2 has no express, hono or ajv. Its dependencies are cross-spawn, eventsource, eventsource-parser, jose, pkce-challenge, zod 4 and `@modelcontextprotocol/core`.
- The API maps almost 1:1 onto the five imports in `src/mcp/client.ts` (checked against the 2.3.1 typings):
  - `Client`, `StreamableHTTPClientTransport`, `Tool` and the `Transport` type come from `@modelcontextprotocol/client`.
  - `StdioClientTransport` and `getDefaultEnvironment` come from `@modelcontextprotocol/client/stdio`.
  - `callTool(params, { signal, timeout, resetTimeoutOnProgress })`.

- [x] **M1.1 Test first.** Add a stdio fixture server, `src/mcp/__fixtures__/fake-mcp-server.mjs`, speaking newline-delimited JSON-RPC: `initialize`, `tools/list`, and `tools/call` with `echo`, `fail`, `hang` and `crash` tools. Tests:
  - Connect and list tools.
  - `echo` returns text.
  - `isError` becomes `Error: …`.
  - `hang` times out within the configured timeout.
  - An abort signal cancels `hang`.
  - `crash` gives an error result, with no hang and no unhandled rejection.
  - A missing command gives an error string within the connect timeout.
  - Server stderr never reaches `process.stderr`.
- [x] **M1.2 Swap the package.** Replace `@modelcontextprotocol/sdk` with `@modelcontextprotocol/client@2.3.1` and adapt the imports. Drop the `as unknown as Transport` cast if the types now line up.
- [x] **M1.3 Pipe server stderr away from the TUI.** Use `stderr: "pipe"` and write it to `~/.anvil/logs/mcp-<name>.log` (or to `--debug` output), so server logs can't corrupt ink (F15).
- [x] **M1.4 Stop leaking the environment.** Use `env: { ...getDefaultEnvironment(), ...config.env }` instead of the full `process.env`. Document in `docs/mcp.md` that servers must declare any variables they need.
- [x] **M1.5 Add timeouts.** Both are configurable per server in `mcp.json`:
  - connect: 15 s by default.
  - each tool call: 60 s by default, with `resetTimeoutOnProgress: true`.
- [x] **M1.6 Connect in parallel and report failures.** In `bootstrap`, connect servers with `Promise.allSettled` and show failures in the startup notice instead of swallowing them.
- [x] **M1.7 Clean up overrides.** Remove the stale ones (`fast-uri`, `ip-address`, `hono`, `@hono/node-server`, `body-parser`) and the interim `proxy-addr` override. First confirm with `pnpm why` that each package is gone.

**Validation stop:**

1. The gate passes.
2. `pnpm audit --prod` reports no critical or high findings.
3. Manual check with your real MCP config:
   - Tools are listed.
   - An Obsidian tool call works.
   - A broken server entry shows a notice without slowing startup.

## M2 — Test tooling majors (0.5 d)

Do this before writing the many new tests in M3–M8.

- [x] **M2.1 Vitest 5.0.x** (5.0.3 today; needs Node `^22.12`, 24 or 26+, and Vite 6.4+). Sweep for the breaking changes that can affect this repo:
  - `clearMocks` is on by default, so a test that reads mock calls made in an earlier test breaks.
  - An un-awaited `expect(...).resolves` or `.rejects` now fails the test. None exist today.
  - `vi.mock` inside a function or `describe` now throws. None exist today.
  - Test titles and inspected values use pretty-format, so `test.each` titles and inline snapshots may change.
  - `sequential` is removed; use `{ concurrent: false }`.
  - Config files are no longer looked up in parent directories.
  - Artifacts go to `.vitest/`; add it to `.gitignore`.

  Run both `pnpm test` and `pnpm test:integration`; the test count must stay at 178 or more.
- [x] **M2.2 MSW 3.0.x** (3.0.3 today; ESM-only, Node 22.12+, TypeScript 5.9+).
  - Rename `onUnhandledRequest` to `onUnhandledFrame` in the four `server.listen()` calls (bootstrap and the three provider tests).
  - MSW 3 no longer manages cookies in Node, so the `localStorage` shim in `vitest.setup.ts` is probably obsolete. Remove it if the tests pass without it.
  - MSW no longer patches `setTimeout`. No test uses fake timers today.
- [x] **M2.3 Coverage baseline.** Add `@vitest/coverage-v8` and a `test:coverage` script. Report on `src/{agent,engine,provider,session,lsp,tools}/**`, with no thresholds yet. Vitest 5 matches coverage patterns against root-relative paths.
  - Baseline, as % lines / % branches: agent 91 / 83, engine 87 / 69, session 85 / 67, provider 76 / 52, tools 48 / 24, lsp 7 / 0. Overall 59 / 43.

**Validation stop:** the gate passes, and the coverage baseline is recorded.

## M3 — Stop the hangs and crashes (1.5 d)

- [x] **M3.1 LSP fails soft** (F4).
  - **Test first,** using a fake LSP fixture (Content-Length-framed stdio, `src/test-support/fake-lsp-server.mjs`):
    - `initialize` against a missing binary resolves to an error within the timeout. Today it hangs forever.
    - A request to a silent server times out.
    - Pending requests reject when the server exits.
    - `shutdown()` on an unresponsive server returns within 3 s and kills the process.
    - A server that floods stderr still answers. Today nothing reads its stderr pipe, so the server blocks once it fills.
  - **Change `lsp/client.ts`** (`startProcess`, `request`, `shutdown`):
    - Handle the child's `error` and `exit` events.
    - Add per-request timeouts: 10 s, or 30 s for `initialize`.
    - Bound shutdown: send the `shutdown` request (2 s), then the `exit` notification, then kill.
    - Ignore the server's stderr.
  - **Change `lsp/manager.ts`** (`getClient`): share one start per language for the session, failures included, and emit one notice, "LSP unavailable: typescript-language-server not found". A shutdown during a start isn't reported as unavailable.
- [x] **M3.2 The diagnostic injector never blocks or throws** (F4, F5).
  - **Test first:** the original result comes back when the tool result is an error, when `ensureOpen` fails with ENOENT, and when no diagnostics arrive within 3 s.
  - **Change:** add a guard, a timeout and a catch in `lsp/inject.ts`. `ensureOpen` keeps throwing on a missing file, so the LSP tools report it instead of claiming "no errors".
- [x] **M3.3 Tool post-processing can't escape the error boundary.**
  - **Test first:** when `transformToolResult` throws during `approve()`, the tool's own result is kept, a warning is shown and the loop continues.
  - **Change:** guard the call in a shared `runTool` helper. Post-processing only adds diagnostics, so its failure must not turn a successful result into an error.
- [x] **M3.4 Hotfix for the swallowed message** (F1).
  - **Test first:** cancel during final-answer streaming, then `send()`; the provider receives the request.
  - **Change:** reset `cancelled` at the start of `send`, `approve` and `reject`. M6.1 replaces this with turn-scoped aborts.
- [x] **M3.5 Hotfix for TUI stale closures** (F8).
  - Read `pendingToolName.current` instead of `pendingTool` after each `await`.
  - Call `setBusy(true)` at the start of `handleApproval`.
  - Never auto-retry while an approval is pending, or after an auto-approved step fails.
  - A turn that pauses for approval is saved and idle. Stop hooks run only when the turn ends.

  Verify manually with S2; M8 replaces this code and adds tests.
- [x] **M3.6 Crash guards** (F5).
  - A turn that throws in the TUI's `processEvents` ends like an error event: the error is shown, the TUI goes idle and the turn is saved.
  - The CLI and the TUI install process-wide `unhandledRejection` and `uncaughtException` handlers from `shared/crash-guard.ts`. `main.ts` owns neither the session nor the terminal, so it stays out of it.
  - On a crash: restore the terminal (unmount ink, disable raw mode, show the cursor), flush the session, write `~/.anvil/logs/crash-<ts>.log`, say how to resume and exit 1. One-shot runs still aren't saved.
  - **Test first:** unit-test the installer with injected `flush`, `log` and `exit`, including each step failing.
- [x] **M3.7 `edit_file` replaces literally** (F10).
  - **Test first:** replacements containing `$&100`, `$$` and `$1` are written as-is, and an empty `search` is an error. Today an empty search inserts at the start of the file.
  - **Change:** use `content.replace(search, () => replace)` and validate the input.
- [x] **M3.8 Guarded history parsing.**
  - **Test first:** a stored tool call with `arguments: "{bad"` doesn't throw in Ollama's `buildMessages`.
  - **Change:** add a safe-parse helper that returns a `Result` and falls back to `{}`.
- [x] **M3.9 Hooks can't crash the loop.**
  - **Test first:** an async hook whose shell can't start doesn't crash the process, and a hook that can't start (e.g. a malformed command) counts as failed instead of rejecting.
  - **Change:** `runHooks` never rejects, so callers that don't await it are safe, and fire-and-forget hooks handle spawn errors.
- [x] **M3.10 Bounded shutdown.** Today `cli.ts` can hang on exit.
  - **Test first:** `shutdownServices` gives up after 3 s when teardown hangs, doesn't make language servers wait for MCP servers, and leaves no timer behind.
  - **Change:** `ctx.shutdown()` runs MCP and LSP teardown in parallel instead of one after the other, and races it against a 3 s timeout. `settleWithin` moves to `shared/` for this second user.
- [x] **M3.11 LSP protocol fixes.** Found during M3.1.
  - **Test first,** with the fake server:
    - A response with non-ASCII text (e.g. hover docs containing "→") is parsed. Today the client measures a byte-based `Content-Length` in characters and waits for the rest of the frame until the request times out. A character split across two reads also turns into `\ufffd`s.
    - A server request that reuses a pending id (e.g. `workspace/configuration` with id 1 during `initialize`) gets an answer, and `initialize` still resolves with the real response. Today the request is taken as the response and never answered.
  - **Change `lsp/client.ts`:** buffer bytes instead of strings, and answer server requests (`null`, or one `null` per `workspace/configuration` item) instead of matching them to pending requests.
- [x] **M3.12 Closing the readline CLI exits cleanly** (F20). Found during the M3 validation stop.
  - **Test first:** a question that is pending when the interface closes, or asked after it closed, rejects with a prompt-closed error. Today the pending one never settles.
  - **Change:** every CLI prompt goes through `ask()` in `ui/ask.ts`, which aborts the question on `close`. A closed prompt counts as quitting, not as an error, so the turn is saved, `ctx.shutdown()` runs and the exit code is 0.

**Validation stop:** the gate passes, plus S2, S3 and S6.

## M4 — Never lose a session (1 d)

- [x] **M4.1 Atomic saves.**
  - **Test first:** a failed write returns `err` and leaves the previous file intact. No temp file is left behind, even when the rename fails, and listing skips temp files left by a crashed save.
  - **Change:** `saveSession` writes `<file>.tmp-<pid>`, renames it over the session file, and returns a `Result` instead of throwing. Both UIs show a failed save as a warning and carry on.
- [x] **M4.2 Save after every committed message.**
  - **Test first:**
    - The engine tells commit listeners about each user message, finished answer and tool result. It doesn't tell them about the system prompt, replaced history or an answer that failed mid-stream.
    - The user message is on disk before the request goes out. A one-shot run never saves.
  - **Change:**
    - Add an `onCommit(listener)` hook to the engine.
    - Add a small `SessionWriter` (`id()`, `save(usage?)`, `startNew()`, `resume(id)`). `openSession` in `bootstrap` wires it to `onCommit` once, so both UIs get it.
    - This also covers `/plan`, which the CLI never saved.
    - The UIs' end-of-turn saves now only add token usage and report a failed save. The crash guard's `flush` returns the writer's `Result`.
    - Cancelling `/history` in the CLI no longer forks the conversation into a new file.
- [x] **M4.3 Handle signals.**
  - SIGINT, SIGTERM and SIGHUP cancel the agent, close the UI, flush the session, run the bounded shutdown, then exit with the conventional signal status.
  - Route `/quit`, `/exit` and double Ctrl+C through the same idempotent `gracefulExit()`.
  - The readline CLI cancels an active turn before closing on double Ctrl+C.
  - **Test first:** injected handlers verify cleanup order, idempotence, failure handling and signal exit codes.
- [x] **M4.4 Repair sessions on load.** 📊 7 sessions end on unanswered tool calls.
  - **Test first:** a pure `repairHistory(messages)` inserts interruption results for unanswered calls, drops orphan/duplicate tool results, and flags a user request without a final assistant reply.
  - **Change:** apply it on `--resume` and when loading a session from the CLI history list; the CLI reports when the loaded request still needs an answer.
- [x] **M4.5 Validate before every request** (defense in depth). `validateHistory()` checks tool-call/result pairing and order before chat and compaction model requests; a trailing user message remains valid at the request boundary. Tests reject malformed tool history; runtime repairs it before sending and logs the repair with `--debug`.

**Validation stop:** the gate passes, plus S4 and S6. For S4, use `kill <pid>` mid-stream: the user message must persist and the file must be valid JSON.

## M5 — Honest streams (1.5 d)

**Rule:** every stream ends with exactly one terminal chunk. It is either `done` with a `finishReason` (`stop`, `length` or `tool_calls`) or `done` with an `error`. Add `{ kind: "cancelled" }` to `ProviderError`.

`StreamChunk.error` already exists and the engine already handles it; Ollama simply never emits it.

- [x] **M5.0 Test helpers** in `src/test-support/mock-ollama.ts` and `mock-openai.ts`. Real `node:http` servers with scripted turns and recorded requests. They inject faults via `delayMs`, `stallAfter`, `dropAfter`, `errorLine` and `httpStatus`, and are reused by M6–M8 and the e2e tests.
- [x] **M5.1 Ollama** (`parseNDJSONStream`, `readStream`). **Test first:**
  - A socket drop yields an `error` of kind `connection`.
  - A `{"error":"model runner has unexpectedly stopped"}` line yields an `api` error carrying that message.
  - A mid-stream stall longer than `streamTimeout` yields `timeout`. Today's test only covers the connect stage.
  - An abort yields `cancelled`, and the server sees the socket close, so Ollama stops generating.
  - `done_reason: "length"` yields `finishReason: "length"`.
- [x] **M5.2 OpenAI-compatible and llama.cpp.** **Test first:**
  - A drop yields `connection`.
  - An abort yields `cancelled`, not "Connection timed out".
  - `data: {"error":…}` yields an `api` error.
  - Two `tool_calls` in one delta are both assembled. Today only index 0 is.
  - A `<think>` tag split across chunks never leaks into content.
- [x] **M5.3 Engine** (`stream`, `processChunk`). **Test first:**
  - Partial text followed by an error is committed with `status: "error"`, and the `error` event is still yielded.
  - Partial text followed by a cancel is committed with `status: "interrupted"`.
  - Incomplete tool calls are dropped.
  - When the consumer `break`s, the state returns to `idle` in a `finally`. The reader is cancelled, not just `releaseLock`ed.
  - The abort check runs even when no chunk arrives.
- [x] **M5.4 Message status.**
  - Add an optional `status` to `Message` and persist it.
  - Providers append "[response interrupted]" when sending such a message back.
  - UIs render a dimmed label.

**Validation stop:** the gate passes, including the first `pnpm test:integration` run, plus S1. Partial answers must be labeled, and the next message must work.

## M6 — Agent loop integrity (2 d)

- [x] **M6.1 Turn-scoped cancellation** (F1, F12).
  - Replace the shared `cancelled` boolean with one `AbortController` per `send`, `approve` or `reject` run, and pass its signal to `engine.stream` (`StreamOptions.signal` already exists).
  - `cancel()` returns a promise that resolves once the run's generator has finished. It waits at most 5 s, then reports the delay and exposes the idle state while keeping overlapping turns blocked until cleanup actually finishes.
  - Cancellation now completes before graceful shutdown saves and closes the UI. Both interactive UIs stay busy until the generator unwinds; the readline CLI no longer offers to retry an interrupted response.
  - **Test first:**
    - `await cancel()` resolves only after the generator ends.
    - `send()` during an active run yields an error event, not interleaved history.
    - `cancel()` while idle is a no-op.
    - A pending approval can resume while its consumer is handling the pending event.
    - Graceful shutdown waits for asynchronous cancellation before saving.
- [x] **M6.2 Every tool call gets exactly one result** (F6).
  - Process an assistant message's calls as a queue. An approval pauses it; `approve` or `reject` resumes it with the remaining calls.
  - Cancel synthesizes a `"[cancelled by user]"` result for each unprocessed call, including cancellation at an approval prompt.
  - `pending` events carry `{ index, total }`, shown by both interactive interfaces.
  - **Test first:**
    - read + `run_cmd` (needs approval) + read, approved: 3 results in order, and the next request's IDs match.
    - A cancel at the approval prompt leaves a valid history.
    - A rejection with a reason: the model sees the reason, and later calls are still processed.
- [x] **M6.3 Remove the early return in `processOutcome`** that orphans every call after a pending one. Covered by the M6.2 tests.
- [x] **M6.4 Only recover tool calls from assistant messages** (`tryRecoverToolCall`). JSON inside a user message is never treated as a tool call.
- [ ] **M6.5 Request-only reminders.**
  - `injectRoundContext` stops persisting round and goal notes.
  - `tryNudge` nudges stay persisted but are marked `synthetic`.
  - **Test first:** after 5 rounds the history holds no reminders, but the last request includes the current one.
- [ ] **M6.6 Trimming keeps the conversation coherent** (`engine.trimMessages`). **Test first:**
  - The first user message (the task) is never dropped.
  - The window never starts with an `assistant` or `tool` message.
  - Tool groups are removed whole.
- [ ] **M6.7 Compaction respects message groups** (`compactHistory`). **Test first:**
  - `KEEP_RECENT` snaps to group boundaries.
  - The original task and the latest user message survive verbatim.
  - The summary input is budgeted from `contextSize`, keeping head and tail. Today `.slice(0, MAX_SUMMARY_INPUT_CHARS)` (40,000 characters) keeps only the oldest content.
- [ ] **M6.8 Compaction on overflow still runs after an error event** in the TUI.
- [ ] **M6.9 Live loop settings** (F18). The loop reads the system prompt, provider and `contextSize` through getters instead of boot-time values. **Test first:**
  - After a provider switch, compaction calls the new provider.
  - After `setActiveSkill`, the next request's system message contains the skill body.

**Validation stop:** the gate passes, plus S1, S5 and S2. Run S2 against LiteLLM too: no HTTP 400. Repeat S5 after `/model <other-provider>/<model>`.

## M7 — Cancellation all the way down (1.5 d)

- [ ] **M7.1 Tool context.** Thread `execute(args, { signal, projectRoot })` through the registry and `executeTool`. An aborted tool returns `"[cancelled by user]"`.
- [ ] **M7.2 `run_cmd`** (F7, F19).
  - **Change:**
    - Spawn with `detached: true` so the command gets its own process group, and with `stdio: ["ignore", "pipe", "pipe"]`.
    - On abort or timeout, send SIGTERM to the group, then SIGKILL after 2 s.
    - Report "timed out after N s" or "cancelled", with the real exit code or signal.
    - Keep draining the pipes past the kept output, so chatty commands no longer die at 1 MB. M10.9 changes what is kept.
  - **Test first,** with real child processes:
    - A `node -e "setInterval(()=>{},1e3)"` child is gone within 3 s of the abort.
    - A grandchild from `sh -c "sleep 100 & wait"` is killed too.
    - A child that reads stdin doesn't hang.
    - A command that prints 2 MB runs to completion and reports exit code 0.
- [ ] **M7.3 Web tools.**
  - **Change:** `web_fetch` and `web_search` use `AbortSignal.any([signal, AbortSignal.timeout(ms)])`.
  - **Test first:** a delayed MSW response gets aborted.
- [ ] **M7.4 MCP.** Pass `{ signal }` to `callTool`. **Test first** with M1's `hang` tool.
- [ ] **M7.5 LSP injection honors the signal.** Skip diagnostics when the turn is aborted.
- [ ] **M7.6 Loop-level test.** Cancel during a 3-tool message:
  - No further tools run.
  - Synthesized results are recorded.
  - `await cancel()` returns in under 1 s for in-process tools and under 3 s for `run_cmd`.

**Validation stop:** the gate passes, plus S2 and S1 during a slow `run_cmd` such as `sleep 60`.

## M8 — Shared session controller, thin TUI and CLI (4 d)

The target API lives in `src/controller/`. It is headless and is the only owner of turn orchestration:

```ts
type Phase = "idle" | "streaming" | "executing" | "awaiting_approval" | "cancelling" | "compacting";

type SessionController = {
	submit: (input: string) => Promise<void>; // chat text or /command; rejected with a notice while busy
	approve: (scope: "once" | "always") => Promise<void>;
	reject: (reason?: string) => Promise<void>;
	cancel: () => Promise<void>; // resolves when the turn has settled (bounded)
	subscribe: (listener: (event: ControllerEvent) => void) => () => void;
	getState: () => ControllerState; // phase, pending {call, index, total}, streaming text, session, model, tokens
	shutdown: () => Promise<void>; // flush and bounded teardown
};
```

- [ ] **M8.1 Controller and command registry, with tests.**
  - Tests run the real loop against the mock Ollama server in a temp project dir.
  - One registry serves `/model`, `/agent`, `/skill`, `/plan`, `/compact`, `/rewind`, `/history`, `/resume`, `/retry`, `/continue`, `/new`, `/quit` and `/help`.
  - **Test first:**
    - A send emits events and saves after each commit.
    - The approval queue works, and `approve("always")` remembers the tool.
    - A cancel mid-stream or mid-tool settles, and the next submit works.
    - A submit while busy is rejected.
    - An empty response retries once with a request-only nudge, never while an approval is pending.
    - `/retry` never duplicates the user message (F17).
    - `/model`, `/skill` and `/agent` take effect on the next request (built on M6.9).
    - `/rewind N` counts user turns, as the CLI does today. The TUI keeps `n*2` messages, which splits tool groups.
- [ ] **M8.2 Port the readline CLI first.** It's smaller, so it validates the API.
  - It fixes F17's dropped second pending call and the preview reading `search`/`replace`.
  - Queue lines that arrive during a turn (F21). Only the `> ` prompt takes them, never an approval. Ctrl+C clears the queue, and EOF on piped stdin runs what's queued before exiting.
  - **E2E test:** spawn `node dist/main.js` with piped stdio and `HOME=<tmp>`, against the mock server. Simple mode is chosen automatically when stdout isn't a TTY. Pipe in two prompts and `/quit`; both prompts must run.
- [ ] **M8.3 Port the TUI.**
  - Split `src/tui/app.tsx` into an exported `App({ controller })` view and an entry module that bootstraps and renders. Today the module bootstraps at import time, which makes it untestable.
  - Subscribe to state with `useSyncExternalStore`, which removes the stale closures (F8).
  - Keys:
    - Esc cancels (F16; fixed in M6.1).
    - Ctrl+C cancels when busy or awaiting approval; when idle, a double press exits.
  - The approval prompt shows "1 of N" and a diff preview for `edit_file` and `write_file`.
- [ ] **M8.4 Component tests** with `ink-testing-library` 4.0.0. It's verified with ink 8: typing, Enter, Esc and Ctrl+C all register. Use a fake controller and cover:
  - y/n/a approval.
  - Esc calling `cancel()`.
  - Ctrl+C semantics.
  - ↑/↓ history.
  - Rendering of pending prompts, streaming text and notices.
- [ ] **M8.5 Delete the duplicated orchestration** from both UIs once parity is verified.
- [ ] **M8.6 Docs.**
  - `docs/architecture.md`: add the controller layer.
  - README keybindings: Esc is now true in both UIs.
  - `CLAUDE.md`: update the project structure.

**Validation stop:** the gate passes, plus S1–S6 in both UIs (`pnpm dev` and `pnpm dev:simple`).

## M9 — ink 8 and rendering (1 d)

- [ ] **M9.1 Upgrade `ink` from 7.1.1 to 8.0.0.** `ink-text-input` 6 and `ink-spinner` 5 stay, since their peer ranges are satisfied (verified). None of the breaking changes touch today's code; keep it that way in M8:
  - React 19.3+ is required (done in M0.4).
  - stdin, stdout and stderr are typed as generic streams, without `columns`. Nothing uses `useStdout` or `useStdin`; the status bar reads `process.stdout`.
  - `useInput` drops unrecognized control sequences.
  - `Box` `minWidth` and `maxWidth` accept numbers only. Neither is used.

  ink 8 also fixes several `<Static>` and scrollback bugs, which helps M9.2. Then run the M8.4 tests.
- [ ] **M9.2 Streaming render.**
  - Buffer tokens in a ref and flush at no more than 20 fps.
  - Keep committed messages in `<Static>`.
  - Show only the tail lines while streaming.

  This fixes the per-token re-render flicker.
- [ ] **M9.3 Show progress so slow models don't look stuck.**
  - Show reasoning as a collapsed line, "thinking… N tokens · M s"; `/think` toggles the full text. Today the TUI shows only `[thinking… Ns]`.
  - The status bar shows the phase, elapsed time, and tokens/s from Ollama's `eval_count` and `eval_duration`.
  - While waiting for the first token, show "waiting for model (loading?) 42 s".
- [ ] **M9.4 Don't drop the first Enter.** In 2 of 11 automated pty runs during M0, the first Enter after launch arrived while the terminal was still in cooked mode. ink received `text\n` as typed input, so nothing was sent until the next Enter, and that message had a stray newline. The pre-M0 build does the same; the root cause is unknown.
  - **Test first** (M8.4 harness): typing `hello\n` into the prompt submits `hello`.
  - In the input's `onChange`, treat a trailing `\r` or `\n` as submit and strip it. Trim submitted values.
  - Recheck in a real terminal after M9.1.

**Validation stop:** the gate passes, plus S1 and S6, and a long streaming answer shows no flicker or scrollback corruption. The first message after launch is sent on the first Enter.

## M10 — Small-model ergonomics (3.5 d; ship each item on its own, in this order)

- [ ] **M10.1 Consistent Ollama options** (F11). Every request (`streamChat`, `completeChat`, compaction) sends the same `options.num_ctx`, plus:
  - `options.temperature`. Today it's sent at the top level, where Ollama ignores it.
  - `options.num_predict` from `maxTokens`.
  - `keep_alive` from config, default `30m`, so slow models aren't unloaded between turns.
  - Optionally `think`.

  **Test first:** snapshot the request bodies of both code paths.
- [ ] **M10.2 One source of timeout defaults.**
  - Today the providers fall back to 30 s and 3 s, while the config defaults are 120 s and 300 s.
  - Split `first_token_timeout` (model load plus prompt eval; 300 s by default for local models) from `stream_timeout` (stall between chunks; 120 s).
- [ ] **M10.3 Real token accounting.**
  - Calibrate the chars/4 estimate with `prompt_eval_count` and `eval_count`, or OpenAI's `usage`.
  - Compact proactively at about 80 % of `num_ctx`.
  - Treat `prompt_eval_count` at 95 % of `num_ctx` or more as an overflow: Ollama silently drops the oldest tokens, including the system prompt.
  - **Test first:** mocked final chunks trigger compaction.
- [ ] **M10.4 Retry with backoff before the first token.**
  - On connection refused, a 503, or a timeout while the model loads: retry 3 times (after 2 s, 5 s, 15 s) with a visible "retrying 2/3" notice.
  - Mid-stream failures keep the partial answer (M5) and suggest `/retry`.
- [ ] **M10.5 `/retry` and `/continue`.**
  - `/retry` drops a failed or interrupted partial and re-runs the turn.
  - `/continue` grants another `max_rounds` after "Round cap reached", or continues after `finishReason: "length"`.
- [ ] **M10.6 Lenient tool arguments.** Use `jsonrepair` 3.15.0 (zero dependencies) inside `parseToolArgs`.
  - It repairs trailing commas, single quotes, unquoted keys, code fences and truncated JSON.
  - If the arguments can't be repaired, return a tool error that echoes the schema and an example, so the model can self-correct.
  - This also makes the "lenient parsing" claim in `docs/architecture.md` true.
  - **Test first:** a table of malformed inputs.
- [ ] **M10.7 Recover tool calls written as text.** Handle `<tool_call>{…}</tool_call>` (Qwen/Hermes), fenced JSON and bare `{"name", "arguments"}` objects, in assistant messages only. **Test first:** one fixture per format.
- [ ] **M10.8 More tolerant `edit_file`.**
  - Normalize CRLF.
  - Match in three passes: exact, then line-trimmed, then whitespace-normalized.
  - Multiple matches are an error that lists the count and line numbers, unless `replace_all: true`.
  - No match returns the closest region with line numbers.
  - **Test first:** one fixture per case.
- [ ] **M10.9 `run_cmd` for agents.**
  - Use a non-interactive environment: `CI=1`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`.
  - Keep the head and the tail of the output: the first 2K plus the last 6K characters, with "… N chars omitted …" between. Errors are at the tail (F19).
- [ ] **M10.10 Useful `search`.**
  - Use `rg`, falling back to `git grep -n`, then `grep -rnF`.
  - Search fixed strings by default; `regex: true` opts in to regex.
  - Exclude `node_modules`, `.git` and `dist`.
  - Return `file:line: text`, capped at 100 lines.
  - Report real errors instead of "No matches".
- [ ] **M10.11 Bounded reads.**
  - `read_file`:
    - gets `offset` and `limit`.
    - is capped at 2,000 lines or 100 KB, with a "truncated, continue with offset=…" note.
    - refuses binary files (NUL bytes).
  - `list_dir` and `glob` get caps and truncation notes.
  - `git_diff` output gets a cap.

**Validation stop:**

1. The gate passes.
2. S5 passes, with `ollama ps` showing a single load across compaction.
3. A small model such as `qwen3-agentic` completes a multi-file edit task.

## M11 — Safety hardening (1.5 d)

- [ ] **M11.1 Path confinement.**
  - **Change:** file tools resolve real paths, including `~`, `..` and symlinks. Auto-approval applies only inside the project root; anything outside needs approval.
  - **Test first:** `../`, absolute paths, symlink escapes and `~/.ssh/id_rsa` each produce a pending approval.
- [ ] **M11.2 `web_fetch` needs approval** unless the domain is listed in `web.allow_domains`. **Test first:** the registry's approval rules.
- [ ] **M11.3 No argument injection.**
  - **Change:** `git_diff` rejects refs that start with `-` and uses a `--` separator. Every tool passes argv arrays to `execFile` or `spawn`, never interpolating into a shell string.
  - **Test first:** `--output=/tmp/x` is rejected.
- [ ] **M11.4 One-shot `-c` stops auto-approving everything** (F14).
  - Tools that aren't auto-approvable run only with `--yes`.
  - Without it, skipped calls get an explanatory tool result and are listed on stderr.
  - This is a behavior change, so update the README.
- [ ] **M11.5 Backups and `/undo`.**
  - Move backups from `<project>/.anvil/file-history` to `~/.anvil/file-history/<project-hash>/`.
  - Cap them at 20 versions per file and 50 MB in total.
  - `/undo` restores the last write or edit from this session, after confirmation.
  - **Test first:** create, prune and undo.

**Validation stop:** the gate passes, plus S2 and S3, and an `-c` run without `--yes` shows the `run_cmd` call as skipped.

## M12 — Persistence UX (1.5 d)

- [ ] **M12.1 Session metadata.** Add `cwd`, `provider`, `model`, `agent`, `skill`, a `title` (the first user message, up to 60 characters) and a `status` (`complete`, `interrupted` or `error`). The loader stays backward compatible.
- [ ] **M12.2 Resume per project.** `--resume` picks the latest session for this project root, falling back to the global latest with a notice. `--resume <id>` picks a specific session.
- [ ] **M12.3 Browse and resume past sessions.**
  - In the TUI, `/history` opens an arrow-key picker that loads the chosen session, repairing it on load (M4.4).
  - `/resume <id>` works in both UIs.
- [ ] **M12.4 Startup notice** when the latest session for this project ended mid-turn: "Last session was interrupted — /resume to continue".
- [ ] **M12.5 Measure `listSessions`,** which parses every file. Add an index only past 200 sessions or 200 ms; until then, YAGNI.

**Validation stop:** the gate passes, plus S4 and S6, and resuming works from another directory.

## M13 — CI and maintenance (0.5 d)

- [ ] **M13.1 Bump the actions,** keeping SHA pins with version comments: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0 and `pnpm/action-setup` v6.1.0. Check each changelog for breaking inputs.
- [ ] **M13.2 Node matrix `[22.x, 24.x]`,** with pnpm taken from `packageManager`.
- [ ] **M13.3 Raise the audit gate** to `--audit-level=high --prod`. The production tree is small after M1.
- [ ] **M13.4 Run `pnpm test:integration` in CI.** It uses mock servers only, so no model is needed.
- [ ] **M13.5 Renovate** (P1 in `docs/ideas.md`):
  - Group minor and patch updates.
  - One PR per major.
  - `minimumReleaseAge: "3 days"`.
  - Weekly lockfile maintenance.
  - Auto-merge patches only on green CI.

  Then remove the item from `docs/ideas.md`.

**Validation stop:** CI is green on both Node versions, and the first Renovate PR opens.

---

## Dependency matrix

**Now** is the version at review time. The M0 rows are done.

| Package                              | Now          | Target                               | Kind        | Milestone | Notes                                                  |
| ------------------------------------ | ------------ | ------------------------------------ | ----------- | --------- | ------------------------------------------------------ |
| `@modelcontextprotocol/sdk`          | ^1.30.0      | `@modelcontextprotocol/client` 2.3.1 | prod, major | M1        | Drops the express/hono/ajv chains (critical and highs) |
| `js-yaml`                            | 5.3.0        | 5.4.3                                | prod        | M0        | Moderate advisory                                      |
| `remeda`                             | 2.40.0       | 2.51.0                               | prod        | M0        |                                                        |
| `linkedom`                           | 0.18.9       | 0.18.13                              | prod        | M0        |                                                        |
| `react`                              | ^19.2.8      | 19.3.0                               | prod        | M0        | Required by ink 8                                      |
| `ink`                                | ^7.1.1       | 8.0.0                                | prod, major | M9        | Spike-verified with ink-testing-library 4              |
| `ink-text-input`, `ink-spinner`      | 6.0.0, 5.0.0 | unchanged                            | prod        | -         | Peers satisfied by ink 8                               |
| `neverthrow`, `@mozilla/readability` | 8.2.0, 0.6.0 | unchanged                            | prod        | -         | Already latest                                         |
| `jsonrepair`                         | new          | 3.15.0                               | prod        | M10       | Zero dependencies                                      |
| `@biomejs/biome`                     | 2.5.8        | 2.5.15                               | dev         | M0        | Then `biome migrate`                                   |
| `oxlint`                             | 1.78.0       | 1.87.0                               | dev         | M0        |                                                        |
| `tsx`                                | 4.23.12      | 4.23.15                              | dev         | M0        |                                                        |
| `vite`                               | ^8.2.1       | 8.3.4                                | dev         | M0        |                                                        |
| `dprint`                             | 0.55.2       | 0.62.0                               | dev         | M0        | Review Markdown diffs                                  |
| `@types/react`                       | ^19.2.18     | 19.3.0                               | dev         | M0        |                                                        |
| `@types/node`                        | 26.2.0       | ^22 (22.20.5)                        | dev         | M0        | Match the runtime floor                                |
| `vitest`                             | 4.1.10       | 4.1.11, then 5.0.x                   | dev, major  | M0, M2    | Moderate advisory first, then the major                |
| `msw`                                | 2.15.0       | 3.0.x                                | dev, major  | M2        |                                                        |
| `@vitest/coverage-v8`                | new          | match vitest                         | dev         | M2        |                                                        |
| `ink-testing-library`                | new          | 4.0.0                                | dev         | M8        | Verified with ink 8                                    |
| `typescript`, `tsup`                 | 7.0.2, 8.5.1 | unchanged                            | dev         | -         | Latest; tsdown is still 0.x                            |

## Test strategy

- **Unit** (colocated `*.test.ts`): pure logic, such as `repairHistory`, `validateHistory`, trimming and compaction boundaries, argument repair, edit matching and truncation.
- **Provider contracts:** run socket-level faults (drop, stall, error lines, abort) against the M5.0 `node:http` mock servers. Keep MSW for request and response shapes.
- **Loop and controller integration:** run the real loop and the real built-in tools in a temp project dir against the mock provider. After each step, assert on the events, on `validateHistory()` and on the session file.
- **Component:** use `ink-testing-library` against the thin TUI view with a fake controller. Playwright component tests don't apply to a terminal UI; this replaces them.
- **E2E** (`*.integration.ts`, run by `pnpm test:integration`): spawn `node dist/main.js` with `HOME=<tmp>` and a config that points at the mock server.
  - Use piped stdio for conversations.
  - Use `-c "<prompt>" --yes` for one-shot runs.
  - Send SIGTERM mid-stream to check that the session file is valid and complete up to the last commit.
- **Regression mapping:** every finding F1–F21 gets at least one test named after it, for example `it("F1: next send after cancel reaches the provider")`.

## Parking lot (not scheduled)

- **Append-only JSONL session format.** Crash-safe by construction, and it enables Pi-style branching and forking.
- **Type-ahead and steering while the agent runs.** Queue the input and deliver it at the next round boundary.
- **Headless `--json` event stream** for editor integrations. Cheap once M8 lands.
- **Per-model capability profiles** in `docs/models.md`: tool-calling reliability, recommended `num_ctx` and temperature.
- **Real-pty TUI smoke test.** `node-pty` needs a native build, so add it only if the component tests miss regressions.
- **Session retention policy** (`max_sessions`, `max_age_days`).
- **Restart a crashed language server.** Today, after a crash the LSP tools return "exited with …" until anvil restarts.
