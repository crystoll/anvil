# Future Development Ideas

All items are potential work — not confirmed. Prioritized by value and effort.

## Priority 1 — Tooling & CI

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
