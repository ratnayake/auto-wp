import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'e2e',
    include: ['tests/**/*.e2e.test.ts'],
    testTimeout: 600000,
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
