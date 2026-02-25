import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [".opencode/plugins/code-buddy-src/tests/**/*.test.ts"],
        globals: true,
    },
});
