# Contributing

This is a personal research project. Contributions are welcome but support is limited.

## Getting Started

```bash
pnpm install
pnpm dev          # Run the CLI
pnpm test         # Run tests
pnpm check        # Type-check
pnpm lint         # Biome + oxlint
```

## Guidelines

- Open an issue before large changes
- Include tests for new features
- Run `pnpm lint && pnpm check && pnpm test` before submitting

## Code Style

Enforced by Biome. Run `pnpm format` to auto-fix. See `CLAUDE.md` for conventions (functional style, neverthrow for errors, no thrown exceptions in business logic).
