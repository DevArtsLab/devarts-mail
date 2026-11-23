import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:email": new URL(
        "./test/stubs/cloudflare-email.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
