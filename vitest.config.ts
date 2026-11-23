import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Unit and component tests. Core logic runs in plain Node; files that render
// React opt into a browser-like DOM with a `// @vitest-environment jsdom` line.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // spies and mocks are put back after every test. Stubbed globals are not: tests that stub one unstub it themselves
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // a floor, not a target: the build fails if coverage slips below it
      thresholds: { statements: 98, branches: 94, functions: 98, lines: 98 },
    },
  },
})
