# Security Notes

## Dependency Audit

Run `pnpm audit` periodically. CI runs `pnpm audit --audit-level=critical --prod` on every PR.

### Known Accepted Vulnerabilities

| Package                       | Severity      | Why Accepted                                                                                         | Upgrade Path                                                                                              |
| ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| js-yaml 4.1.1                 | moderate      | Prototype pollution via `<<` merge key. We only parse trusted config files (`~/.anvil/config.yaml`). | Upgrade to js-yaml 5.x requires code changes — `load()` return type changed. Track in a separate PR.      |
| vite/esbuild (via vitest 2.x) | moderate–high | Dev-only — not shipped in binary. Only affects local dev environment.                                | Upgrade to vitest 4.x — breaking changes in test infrastructure (temp dirs, mocking). Separate migration. |

### Last Reviewed

2026-06-27

## CI Supply Chain Hardening

- GitHub Actions pinned to commit SHAs (not tags)
- `pnpm install --frozen-lockfile` in CI (no silent dep changes)
- `pnpm audit --audit-level=critical --prod` gates PRs
- pnpm lockfile provides exact version pinning
