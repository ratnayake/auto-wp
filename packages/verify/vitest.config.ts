import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'verify', include: ['test/**/*.test.ts'], testTimeout: 60_000 },
});
