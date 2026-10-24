import { defineConfig } from 'vitest/config';

// Each package/app with tests is its own project; `pnpm e2e` selects the e2e project.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'e2e'],
  },
});
