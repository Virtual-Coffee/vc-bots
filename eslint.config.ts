import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["node_modules/", ".wrangler/", "dist/", "worker-configuration.d.ts"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Repo invariants from CLAUDE.md — enforced here, not just reviewed.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message: "The Worker runs on workerd — no node:* modules; use Web APIs (CLAUDE.md).",
            },
          ],
          paths: [
            {
              name: "@slack/web-api",
              message: "Not edge-compatible; import from slack-cloudflare-workers (CLAUDE.md).",
            },
            {
              name: "slack-web-api-client",
              message:
                "Transitive dependency; import its re-exports from slack-cloudflare-workers (CLAUDE.md).",
            },
            {
              name: "slackify-html",
              message:
                "Throws on workerd; descriptions are Markdown, rendered with slackify-markdown (CLAUDE.md).",
            },
          ],
        },
      ],
      "no-console": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `declare global { namespace Cloudflare { interface Env … } }` is how wrangler's generated
      // Env is augmented (test/reminders-cron.test.ts).
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
    },
  },
  {
    // Root config files (eslint.config.ts, vitest.config.ts) sit outside tsconfig `include`
    // and pull in Node/wrangler types the Worker project doesn't have — syntax-only lint.
    files: ["*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // One-off CLIs (`pnpm fix-calendar`) run under plain `node`, sit outside tsconfig
    // `include` like the root config files, and print to stdout by design.
    files: ["scripts/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-console": "off" },
  },
  {
    // The leveled logger is the one sanctioned console caller.
    files: ["src/log.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Spies, fixtures and canned payloads make the unsafe-* family noisy in tests;
    // no-floating-promises stays on so a forgotten `await` still fails.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
