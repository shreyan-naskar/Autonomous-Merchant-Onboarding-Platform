import { defineConfig } from 'vitest/config';

// Root runner: `npm test` runs every workspace's tests as separate projects.
export default defineConfig({
  test: {
    projects: ['api', 'mock-providers', 'shared', 'web'],
    passWithNoTests: true,
  },
});
