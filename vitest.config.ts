import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Several suites drop and recreate the public schema of the same test
    // database. Running files in parallel lets them clobber each other, which
    // shows up as spurious failures that vanish when run individually.
    fileParallelism: false
  }
});
