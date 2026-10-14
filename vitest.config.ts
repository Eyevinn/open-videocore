import { configDefaults, defineConfig } from 'vitest/config';

// e2e/ has its own node:test suite (see e2e/README.md); the root `vitest run` in `ci` must not pick it up.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
