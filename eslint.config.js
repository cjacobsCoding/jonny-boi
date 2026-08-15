import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Shared flat ESLint config for the whole workspace.
 * Reasonable rules: type-aware linting via typescript-eslint's recommended
 * set, with Prettier disabling all stylistic rules so formatting is owned by
 * Prettier alone (one mechanism per concern).
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dev-dist/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Build-time scripts run in Node, outside the browser/worker bundles, so
    // they legitimately reach for Node's globals.
    files: ['scripts/**/*.{js,mjs}', '**/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        // `import.meta.url`-relative path resolution is the standard way an ESM
        // script finds a sibling file, so `URL` belongs here with the rest.
        URL: 'readonly',
      },
    },
  },
);
