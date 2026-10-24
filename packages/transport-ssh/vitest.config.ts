import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'transport-ssh',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 240_000,
  },
});
