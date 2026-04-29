import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@artifact-validation/adapters": path.join(rootDir, "packages/adapters/src/index.ts"),
      "@artifact-validation/contracts": path.join(rootDir, "packages/contracts/src/index.ts"),
      "@artifact-validation/file-store": path.join(rootDir, "packages/file-store/src/index.ts"),
      "@artifact-validation/llm-integration": path.join(rootDir, "packages/llm-integration/src/index.ts"),
      "@artifact-validation/runtime-client": path.join(rootDir, "packages/runtime-client/src/index.ts"),
      "@artifact-validation/runtime-core": path.join(rootDir, "packages/runtime-core/src/index.ts")
    }
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx"
    ],
    globals: false
  }
});
