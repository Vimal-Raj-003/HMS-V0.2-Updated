// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';

/**
 * Vim's HMS lint policy — enforces `CLAUDE.md` §4 and `docs/09-quality-gates-and-testing.md` §15 stage 2.
 *
 * The rules that are *not* stylistic (and therefore must never be downgraded to warnings):
 *   - no `any`                       → CLAUDE.md §4
 *   - no `console.log`               → CLAUDE.md §4 (PHI leakage risk; use the pino logger)
 *   - module boundaries              → docs/01-architecture.md §4 (a module may only touch its own tables)
 *   - no `SET SESSION` / `SET app.`  → docs/07 §4 (would leak tenancy across a PgBouncer-pooled connection)
 *   - no `OFFSET` in repositories    → docs/07 §4 (cursor pagination is mandatory)
 *   - no raw SQL string concatenation → docs/04 §6
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/coverage/**',
      '**/*.config.{js,mjs,cjs}',
      'scripts/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      // ---- CLAUDE.md §4: no `any`, no console.log, no secrets ------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      'no-console': 'error',

      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // ---- docs/04 §6: injection safety -------------------------------------------
      'no-restricted-syntax': [
        'error',
        {
          // `SET app.x` / `SET SESSION` would survive past the transaction on a
          // PgBouncer transaction-mode connection and leak one tenant's scope into
          // the next request. Only `SET LOCAL` is permitted. docs/07 §4.
          selector:
            "CallExpression[callee.property.name=/^(query|unsafe|executeRawUnsafe|queryRawUnsafe|\\$executeRawUnsafe|\\$queryRawUnsafe)$/] > TemplateLiteral:has(TemplateElement[value.raw=/SET\\s+(SESSION\\s+)?app\\./i]):not(:has(TemplateElement[value.raw=/SET\\s+LOCAL/i]))",
          message:
            'Tenancy must be established with `SET LOCAL` inside the transaction (docs/03 §RLS, docs/07 §4). `SET`/`SET SESSION` leaks across pooled connections.',
        },
        {
          selector: "Literal[value=/\\bOFFSET\\s+\\$?\\d/i]",
          message:
            'OFFSET pagination is banned (docs/07 §4). Use keyset/cursor pagination on (created_at, id).',
        },
        {
          selector: 'TSAsExpression > TSAnyKeyword',
          message: 'No `as any`. Narrow the type or declare a proper contract in packages/contracts.',
        },
      ],

      'no-restricted-globals': [
        'error',
        { name: 'Math', message: 'Inject a Rng from packages/contracts so tests are deterministic (docs/09 §2).' },
      ],
    },
  },

  // ---- services/api: module boundaries ------------------------------------------
  // A module may only import from: its own folder, `src/core/**` (platform),
  // `packages/*`, and another module's *public* `<module>.module.ts` / `index.ts`
  // barrel. Reaching into another module's repository or entities is a build failure.
  {
    files: ['services/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/*/*.repository', '**/modules/*/*/*.repository.js'],
              message:
                "Module boundary violation (docs/01 §4): a module may not import another module's repository. Use its service interface from `module.contract.ts` or subscribe to a domain event.",
            },
            {
              group: ['**/modules/*/*/dto/**', '!./dto/**'],
              message:
                "Module boundary violation (docs/01 §4): DTOs are module-private. Share types via packages/contracts.",
            },
            {
              group: ['**/modules/*/*/repositories/**'],
              message:
                "Module boundary violation (docs/01 §4): repositories are module-private. Go through the owning module's service interface.",
            },
          ],
        },
      ],
    },
  },

  // ---- packages/ui: tokens only, no hard-coded colour ---------------------------
  {
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    ignores: ['packages/ui/src/tokens/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b/]",
          message:
            'No hex colour literals outside packages/ui/src/tokens (docs/06 §11). Consume a semantic token such as var(--color-danger-fg).',
        },
      ],
    },
  },

  // ---- tests: relax the strictest type rules, keep the safety ones --------------
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/__tests__/**/*.ts', 'packages/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // ---- seeds & scripts may log --------------------------------------------------
  {
    files: ['packages/db/prisma/**/*.ts', 'packages/db/src/seed/**/*.ts', '**/*.cli.ts'],
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },

  prettierConfig,
);
