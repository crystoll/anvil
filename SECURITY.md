# Security Notes

## Dependency Audit

Run `pnpm audit` periodically. CI runs `pnpm audit --audit-level=critical --prod` on every PR.

### Known Accepted Vulnerabilities

None currently. All prod dependencies are clean.

Dev-only vulnerabilities (not shipped in binary) may appear in transitive deps of vitest/vite — these are acceptable as they only affect the local dev environment.

### Upgrade Notes

| Package     | Notes                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| js-yaml     | v5 dropped the default export. Use `import { load } from "js-yaml"`.            |
| vitest      | v4 requires vite 6+ (needs `vite/module-runner`). Add vite as explicit dev dep. |
| @types/node | Pin to 22.x to match our Node target (engines field).                           |
| biome       | v2 changes config format + new rules. Separate migration.                       |
| oxlint      | v1 adds new rules. Separate migration.                                          |
| typescript  | v6 — no urgency, 5.7 works fine.                                                |

### Last Reviewed

2026-06-27

## CI Supply Chain Hardening

- GitHub Actions pinned to commit SHAs (not tags)
- `pnpm install --frozen-lockfile` in CI (no silent dep changes)
- `pnpm audit --audit-level=critical --prod` gates PRs
- pnpm lockfile provides exact version pinning
