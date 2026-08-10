// Flat ESLint config for the Tape monorepo.
//
// Fast by design: @eslint/js recommended + typescript-eslint recommended
// WITHOUT type-checking (typecheck has its own CI stage; lint stays seconds).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'tools/perf/report/**',
      // Codemod input fixtures are deliberately weird v1 code (unused vars,
      // odd shapes) — linting them would fight their purpose.
      'packages/tape-codemod/tests/__testfixtures__/**',
      'charts/**',
      '.github/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Standard convention: an `_`-prefixed identifier is a declared-unused
      // placeholder (interface-conformance params like `_delayMs`,
      // `_options`). The prefix is the annotation; the rule still catches
      // everything unprefixed.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Plain-JS Node scripts (tools/api-report.mjs, examples/node-consumer,
  // the codemod bin). The `globals` package is not a root dependency, so
  // the Node globals these scripts use are declared explicitly.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },

  // React rules only where React runs: the react binding and the two apps.
  {
    files: ['packages/tape-react/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },

  // Tests exercise edge cases on purpose: `any` for malformed-input probes
  // and non-null assertions on values the test itself just created are
  // normal test idioms, not production-code smells.
  {
    files: ['**/tests/**', '**/*.test.*', '**/*.spec.*', 'tools/perf/scenarios/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  }
);
