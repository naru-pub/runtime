import { defineConfig } from "vitest/config";

// The runtime's own suites. sdk/spec/ runs under node:test (pnpm test:sdk),
// and dev/ tests the packed package (dev/scripts/check-package.sh).
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
