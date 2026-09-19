# Contributing

We welcome contributions! Please open an issue to discuss what you would like to change before submitting a pull request.

## Getting started

```bash
cd backend-api
pnpm install
pnpm dev
```

## Running tests

```bash
cd backend-api
pnpm test
```

## Pull request checklist

- [ ] `pnpm build` passes (no TypeScript errors)
- [ ] `pnpm test` passes
- [ ] New features include tests
- [ ] No commercial product names, trademarks, or product-specific terminology in any file

## Continuous integration

Every pull request against `main` runs the `ci` workflow, which executes
`pnpm typecheck`, `pnpm test`, and `pnpm build`. A companion `test-guard` check
also runs and fails the PR if the diff weakens the test suite — that is, if it:

- deletes a test file (`*.test.ts` / `*.spec.ts`), or
- net-removes `test(...)` / `it(...)` / `describe(...)` blocks from a test file
  that still exists (commenting them out counts too), or
- changes a coverage threshold in a vitest/vite config.

### Intentionally removing or changing tests

Sometimes removing a test is the right call (a feature was dropped, a test was a
duplicate, etc.). To let such a PR through the `test-guard` check, add a
human-reviewed justification using **either**:

1. A line in the PR body:

   ```
   test-exception: removing duplicate coverage now folded into asset-lifecycle.test.ts
   ```

2. The label `test-exception-approved` on the PR.

Either signal makes `test-guard` pass. Reviewers should confirm the justification
before merging.

## Code style

- TypeScript strict mode
- Zod for all route validation
- Graceful degradation — features should degrade to 501 rather than crashing when optional services are not configured
- No hardcoded credentials or connection strings
