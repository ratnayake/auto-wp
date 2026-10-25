import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'inventory', include: ['test/**/*.test.ts'] } });
