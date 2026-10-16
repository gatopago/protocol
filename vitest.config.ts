import { defineConfig } from 'vitest/config';

export default defineConfig({
  // One file at a time: most start forks, and eleven at once overran their timeouts on a laptop.
  test: { environment: 'node', include: ['test/*.test.ts'], fileParallelism: false },
});
