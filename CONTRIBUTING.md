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

## Code style

- TypeScript strict mode
- Zod for all route validation
- Graceful degradation — features should degrade to 501 rather than crashing when optional services are not configured
- No hardcoded credentials or connection strings
