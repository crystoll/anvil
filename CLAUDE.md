# CLAUDE.md — Anvil Coding Guidelines

## Development Approach

### TDD (Test-Driven Development)

Every feature starts with a failing test. The cycle:

1. **Red** — Write a test that expresses the desired behavior. Run it. It fails.
2. **Green** — Write the minimum code to make the test pass.
3. **Refactor** — Clean up while keeping tests green.

Tests are design tools, not afterthoughts. They specify intent before implementation exists.

- Test files live next to source: `foo.ts` → `foo.test.ts`
- Test names describe behavior: `"returns err when stream times out"`
- Use Vitest: `describe`, `it`, `expect`
- Prefer unit tests for logic, integration tests for provider/tool interactions
- Mock at boundaries (HTTP, filesystem), not between internal modules

### Functional Style

Prefer functional composition over imperative control flow.

**Do:**

```typescript
const processItems = (items: Item[]) =>
  pipe(
    items,
    filter(isActive),
    map(toViewModel),
    sortBy(prop('name'))
  )
```

**Don't:**

```typescript
function processItems(items: Item[]) {
  const result = []
  for (const item of items) {
    if (item.active) {
      result.push(toViewModel(item))
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}
```

Guidelines:

- Use `pipe()` from remeda for data transforms
- Prefer `map`, `filter`, `reduce` over loops
- Avoid mutation — return new values
- No `let` when `const` works
- Expressions over statements where readable

### Error Handling with neverthrow

Never throw in business logic. Use `Result<T, E>` and `ResultAsync<T, E>`.

**Do:**

```typescript
const parseConfig = (raw: string): Result<Config, ParseError> =>
  safeParse(raw)
    .andThen(validateSchema)
    .map(toConfig)
```

**Don't:**

```typescript
function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) // throws!
  if (!isValid(parsed)) throw new Error('invalid')
  return toConfig(parsed)
}
```

Guidelines:

- Functions that can fail return `Result<T, E>` or `ResultAsync<T, E>`
- Define typed error variants: `type ProviderError = TimeoutError | ConnectionError | ParseError`
- Use `andThen` for chaining fallible operations
- Use `map` / `mapErr` for transforming success/error values
- Use `match` or `isOk()`/`isErr()` at boundaries (UI, CLI output)
- Throwing is acceptable only at the outermost boundary (process entry point) or for truly unrecoverable bugs

### Code Style

**Functions:**

- Short. A function should do one thing. If it needs a comment explaining what it does, it should be split or renamed.
- Well-named. `fetchModels` not `getData`. `parseToolCall` not `process`.
- Prefer arrow functions for pure transforms, named functions for complex logic with early returns.
- Max ~20 lines. If longer, extract helpers.

**Variables:**

- Descriptive names. `streamTimeout` not `t`. `activeModel` not `m`.
- `const` by default. `let` only when rebinding is truly needed.
- No `var`. Ever.

**Documentation:**

- JSDoc on exported functions and types. Describe _why_, not _what_ (the name should say what).
- No inline `//` comments unless explaining a non-obvious _why_.
- Type signatures are documentation — make them expressive.

```typescript
/** Streams chat completion, aborting if no chunk arrives within the configured timeout. */
export const streamChat = (
  model: string,
  messages: Message[],
  opts: StreamOpts
): ResultAsync<AsyncIterable<StreamChunk>, ProviderError> => { ... }
```

**Modules:**

- One concept per file. `provider.ts` not `utils.ts`.
- Named exports only (no default exports).
- Group imports: external libs → internal modules → types.

**Types:**

- Prefer `type` over `interface` (more composable, works with unions/intersections).
- Use discriminated unions for state machines and error types.
- Avoid `any`. Use `unknown` + narrowing when the type is genuinely dynamic.
- Branded types for IDs where type safety matters: `type ModelId = string & { readonly __brand: 'ModelId' }`

## Project Structure

```
anvil/
├── src/
│   ├── provider/       # LLM provider abstraction + OpenAI-compatible streaming
│   ├── engine/         # Chat engine (streaming, history, model switching)
│   ├── agent/          # Agent loop state machine with approval gating
│   ├── agents/         # Agent configs — loader, discovery, guards, hooks
│   ├── tools/          # Tool registry + built-in tools (files, shell, web)
│   ├── config/         # Config loading and validation (~/.anvil/config.yaml)
│   ├── session/        # Session persistence (save, load, list)
│   ├── skills/         # Skill parser + discovery (Agent Skills standard)
│   ├── lsp/            # LSP client — diagnostics, navigation, auto-inject
│   ├── mcp/            # MCP client — external tool servers (stdio + HTTP)
│   ├── web/            # Web search (DuckDuckGo) + fetch (Readability)
│   ├── ui/             # Terminal UI helpers (status bar)
│   ├── cli.ts          # Interactive CLI entry point with commands
│   └── index.ts        # Library entry point + VERSION
├── docs/               # Feature documentation (architecture, hooks, LSP, MCP)
├── biome.json          # Biome config (code formatting + linting)
├── dprint.json         # dprint config (markdown formatting)
├── tsup.config.ts      # Build config (bundles cli.ts → dist/)
├── vitest.config.ts
├── tsconfig.json
├── package.json
└── CLAUDE.md           # This file
```

## Commands

```bash
pnpm dev          # Launch interactive CLI (agent mode with tools)
pnpm build        # Production build (tsup)
pnpm test         # Run tests (vitest)
pnpm test:watch   # Tests in watch mode
pnpm lint         # Biome check + oxlint
pnpm format       # Biome format (code) + dprint (markdown)
pnpm format:md    # Format markdown only (dprint)
pnpm check        # Type-check (tsc --noEmit)
```

## Biome Rules to Know

- **`useLiteralKeys`**: Always use `obj.key` not `obj["key"]` for string literals.
- **`noExcessiveCognitiveComplexity` (max 15)**: Extract helpers aggressively. `for await` + `while` + `if` chains hit this fast. Solution: pull loop bodies into named functions.
- **`useTemplate`**: Prefer template literals over string concatenation.
- **`organizeImports`**: Biome auto-sorts imports alphabetically. Run `pnpm format` after adding imports.

## TypeScript Strictness Notes

- **`exactOptionalPropertyTypes`**: Cannot assign `undefined` to optional fields. Build objects incrementally and only add optional properties when they have values.
- **`noUncheckedIndexedAccess`**: Array/object index access returns `T | undefined`. Use `??` or narrowing.

## Decision Rules

- **When uncertain**: Ask. Don't guess at architecture.
- **When two approaches exist**: Pick the simpler one. We can always add complexity.
- **When tempted to abstract**: Wait until you have 3 concrete uses. No premature abstraction.
- **When a function grows**: Extract, don't nest. Flat call chains over deep nesting.
- **When handling errors**: Is this recoverable? → `Result`. Truly impossible? → throw (and document why).
