import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'health', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
