# Security Notes

## Dependency Audit

Run `pnpm audit` periodically. CI runs `pnpm audit --audit-level=critical --prod` on every PR.

### Known Accepted Vulnerabilities

None currently. All dependencies are at their latest versions.

### Upgrade Notes

| Package     | Notes                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| js-yaml     | v5 dropped the default export. Use `import { load } from "js-yaml"`.                        |
| vitest      | v4 requires vite 6+ (needs `vite/module-runner`). Add vite as explicit dev dep.             |
| biome       | v2 changed config format. Run `npx biome migrate --write` then `--fix` for import ordering. |
| typescript  | v6 requires explicit `"types": ["node"]` in tsconfig.json.                                  |
| oxlint      | v1 was a clean upgrade, no changes needed.                                                  |
| @types/node | Pin to 22.x to match our Node target (engines field).                                       |

### Last Reviewed

2026-06-27

## CI Supply Chain Hardening

- GitHub Actions pinned to commit SHAs (not tags)
- `pnpm install --frozen-lockfile` in CI (no silent dep changes)
- `pnpm audit --audit-level=critical --prod` gates PRs
- pnpm lockfile provides exact version pinning
