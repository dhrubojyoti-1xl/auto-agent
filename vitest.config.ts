import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // The same alias Next resolves, so a route handler can be imported and
    // EXECUTED by a test rather than merely read as text. Without it, testing a
    // route means matching its source with regular expressions — which is how a
    // completely broken endpoint once passed ten tests.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Several suites drop and recreate the public schema of the same test
    // database. Running files in parallel lets them clobber each other, which
    // shows up as spurious failures that vanish when run individually.
    fileParallelism: false
  }
});
