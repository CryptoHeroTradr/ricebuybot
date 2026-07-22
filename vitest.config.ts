import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Config is validated at import time; tests set their own env explicitly.
    clearMocks: true,
  },
});
