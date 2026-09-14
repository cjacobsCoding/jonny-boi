import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Shared flat ESLint config for the whole workspace.
 * Reasonable rules: type-aware linting via typescript-eslint's recommended
 * set, with Prettier disabling all stylistic rules so formatting is owned by
 * Prettier alone (one mechanism per concern).
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dev-dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      // Bundler OUTPUT (`npm run bundle:server` → the NAS artifact). Linting a
      // generated bundle reported 226 errors in vendored code nobody edits and
      // drowned the 4 real ones, which is why `npm run lint` sat red.
      'dist-bundle/**',
      // AssemblyScript sources. These carry a `.ts` extension and are NOT
      // TypeScript: `@inline` / `@operator` are AssemblyScript decorators in
      // positions TypeScript forbids, so typescript-eslint fails to PARSE them
      // ("Decorators are not valid here") rather than finding anything real.
      // They are compiled by `asc`, never by tsc, and never bundled.
      'spikes/**/assembly/**',
      // Spike build output: the emitted .wasm/.wat and any generated mirror.
      'spikes/**/build/**',
      // Worker-agent worktrees live INSIDE the checkout (`.claude/worktrees/
      // agent-<id>/`), each a whole second copy of the repo. Linting them from
      // the root reported 388 errors that were four worktrees' worth of the
      // same five warnings plus their unignored spike sources — drowning the
      // real result, exactly as `dist-bundle` once did.
      '.claude/worktrees/**',
    ],
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
    // `bench/` and `spikes/` are the same shape: standalone Node ESM, never
    // bundled — a benchmark harness needs `console`/`global` exactly as a build
    // script needs `process`.
    files: [
      'scripts/**/*.{js,mjs}',
      '**/scripts/**/*.{js,mjs}',
      '**/bench/**/*.{js,mjs}',
      'spikes/**/*.{js,mjs}',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        // `import.meta.url`-relative path resolution is the standard way an ESM
        // script finds a sibling file, so `URL` belongs here with the rest.
        URL: 'readonly',
        // A bench harness measures and reports; `global.gc` is how it forces a
        // collection under `--expose-gc`.
        global: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // A spike that measures a WebAssembly build instantiates the module from
        // Node, where `WebAssembly` is a standard global exactly as `process` is.
        WebAssembly: 'readonly',
        // Global since Node 18, and the repo requires >=20 (root package.json
        // `engines`). Data-fetching scripts use it instead of pulling in a client.
        fetch: 'readonly',
      },
    },
  },
  {
    // A Puppeteer harness is TWO programs in one file: the outer half runs in
    // Node, and everything inside `page.evaluate()` is serialised and run in the
    // BROWSER. Lint sees one file and flags every `document`/`Image`/`btoa` in
    // the inner half as undefined — 19 errors that are all false. Declaring the
    // browser globals here is what makes the real errors in this file visible.
    //
    // ⚠️ A GLOB, NOT A LIST. This was four hand-written paths, and the fifth
    // harness (`verify-combat-visibility.mjs`) arrived with eighteen false
    // `no-undef` errors purely because nobody had added its row — a list that
    // has to be edited to keep working is a trap, not a table. `verify-*.mjs` is
    // already the naming convention every harness follows and the one
    // `harness-wait-budgets.test.ts` DISCOVERS them by, so one convention now
    // answers both questions.
    //
    // Scoped to `apps/web/scripts/` rather than `**/scripts/`, because the
    // repo-root `scripts/verify-deploy.mjs` is pure Node: handing it `document`
    // would turn a real typo there into a silent pass.
    files: ['apps/web/scripts/verify-*.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        sessionStorage: 'readonly',
        // §3.62's harness measures LAYOUT, so it reads resolved styles, and it
        // clears the saved game so the setup screen opens instead of the resume
        // banner.
        getComputedStyle: 'readonly',
        localStorage: 'readonly',
        // Dispatched inside `page.evaluate` to make React see a native <select>
        // change — a controlled input ignores a bare `.value =` assignment.
        Event: 'readonly',
        Image: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        TextDecoder: 'readonly',
        DataView: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        // Used by BOTH halves: the harness inflates the archive's deflated
        // entries to check them, and times its own fetches out.
        DecompressionStream: 'readonly',
        Response: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    // The React app. Three files already carried
    // `eslint-disable-next-line react-hooks/exhaustive-deps`, but the plugin was
    // never installed — so each disable was INERT (suppressing nothing) *and*
    // itself an error, because eslint rejects a disable for an unknown rule.
    // Installing the plugin makes those suppressions mean what they say and
    // turns the dependency check back on for every other hook.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The two classic rules are ERRORS: they catch genuine bugs (a stale
      // closure reading last render's state, a hook behind a condition).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The compiler-era rules are WARN, deliberately. They flag real patterns
      // (5 sync setStates in effects, 1 ref read during render) in UI that
      // currently works, and each needs its own think — a blind mechanical fix
      // is how working screens break. Visible, tracked, not a merge blocker.
      // See COORDINATION.md; fix them one file at a time, then promote to error.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
);
