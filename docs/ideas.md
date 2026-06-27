# Future Development Ideas

## TUI Remaining Gaps

Features present in `--simple` mode but not yet in TUI:

- Input history: cursor-up/down cycles through previous inputs (session-only, both UIs)
- Model selection UX: `/model` shows numbered list of available models (query Ollama `/api/tags`), user picks by number. Later: support listing models from non-Ollama providers, favorites/recent models, fuzzy filter.
- `@path` hint display (show "[attached: path (N lines)]" in TUI when file is attached)

## Code Quality

- **DRY pass**: Review duplication between `cli.ts` and `tui/app.tsx` (command handling, flag parsing, bootstrap). Extract shared logic into common modules to reduce maintenance burden.
- **Internal task/todo tracking**: Agent-side step tracking so multi-step operations don't lose their place. Could be a visible checklist in TUI, or just internal state the agent uses to stay on track.

## TUI Enhancements

- **Multi-pane layout**: Split terminal into conversation pane + tool output/status pane. Would keep tool results visible without scrolling, show plan progress, or display file diffs alongside conversation. Needs investigation into Ink layout capabilities and terminal size handling.

## Tooling & CI

- **Renovate**: Add Renovate to GitHub Actions for automated dependency update PRs. Group minor/patch updates, require CI pass before merge.

## Future Investigations

- **Remote control via Discord/Slack**: Open a session in a folder context, then interact with it remotely over Discord/Slack. Would need a headless daemon mode, message bridge, and auth/session mapping. Explore feasibility and UX.
