# 0008 — ESLint + Prettier + knip, enforced in CI; TypeScript 6 and 7 side by side

**Status:** Accepted (2026-09-17)

## Context

Until now the repo had `tsc --noEmit` and the test suite, and nothing else: no formatter, no
linter, no CI. The rules that matter on `workerd` — no `node:*` modules, no `@slack/web-api`,
no `slackify-html`, no bare `console.*` — lived in CLAUDE.md and `.coderabbit.yaml` review
instructions, so they were reviewed rather than enforced. The code had a consistent
hand-formatted style (2-space, double quotes, semicolons, trailing commas, ~100 columns).

The Worker is promise-heavy (`ctx.waitUntil`, DO `blockConcurrencyWhile`, Slack `fetch`
calls); a dropped promise is the most likely class of silent bug, and only type-aware linting
catches it reliably.

`typescript@7` (the Go compiler, "tsgo") is the project's type checker. It ships **no JS
API**; the API returns in 7.1. typescript-eslint and knip both need it and throw on 7.0.

## Decision

- **ESLint 10 + typescript-eslint `recommendedTypeChecked`** over Biome/oxc: the type-aware
  promise rules (`no-floating-promises`, `no-misused-promises`) are the point. The CLAUDE.md
  invariants are `no-restricted-imports` / `no-console` rules with messages that name the
  document. `test/**` turns off the `no-unsafe-*` family and `unbound-method` (spies and canned
  payloads), keeping `no-floating-promises`. Root config files are syntax-only
  (`disableTypeChecked`).
- **Prettier** configured to the existing style (`printWidth: 100`, `trailingComma: "all"`;
  `*.jsonc` keeps `none` so `wrangler.jsonc` stays conservative). TypeScript and JSON/JSONC
  only; Markdown and YAML are ignored — the ADRs and CLAUDE.md are hand-wrapped prose.
- **knip** reports unused files, exports and dependencies, blocking. `ignoreExportsUsedInFile`
  keeps a module's public types exportable; `cloudflare` is ignored because
  `cloudflare:workers` / `cloudflare:test` are workerd virtual modules; the vitest plugin is off
  because it evaluates `vitest.config.ts`, which reads `wrangler.jsonc` and fails under knip's
  loader.
- **`pnpm check`** = `format:check && lint && typecheck && knip`, and `.github/workflows/ci.yml`
  runs `pnpm check` + `pnpm test` on pull requests and pushes to `main`. Node is pinned by
  `.node-version`. No git hooks and no editor settings: CI is the gate.
- **TypeScript side by side**, Microsoft's documented 7.0 arrangement:
  `"typescript": "npm:@typescript/typescript6"` supplies the TS 6 API to ESLint and knip, and
  `"@typescript/native": "npm:typescript@^7"` keeps `tsc` (and VS Code's `useTsgo`) on TS 7.

## Consequences

- A rule violation is a CI failure with a message pointing at CLAUDE.md, not a review comment.
  `.coderabbit.yaml` still carries the same instructions; they are now redundant, not wrong.
- Two `typescript` packages in `devDependencies` until typescript-eslint supports TS ≥ 7.1
  (typescript-eslint/typescript-eslint#10940). When it does: drop `@typescript/native`, point
  `typescript` back at `^7`, confirm `pnpm exec tsc --version` is 7.x and `pnpm lint` runs.
- Renovate sees both aliases as ordinary npm dependencies; a bump of `@typescript/typescript6`
  is safe, a bump of `typescript` that removes the alias is not.
- New source rules go in `eslint.config.ts` next to the existing ones; a rule that needs a
  disable comment needs a `--` reason on the same line.
