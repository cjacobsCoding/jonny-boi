import type { ReactElement } from 'react';
import { PACKAGE_NAME as CORE_PACKAGE_NAME } from '@jonny-boi/core';

/**
 * Scaffold landing page. Importing CORE_PACKAGE_NAME from `@jonny-boi/core`
 * proves a workspace cross-package import resolves through the PWA build.
 */
export function App(): ReactElement {
  return (
    <main className="app-shell">
      <h1>jonny-boi — MTG deck lab</h1>
      <p>
        Scaffolding in place. The deck builder, card browser, A/B tuning lab, and match viewer
        arrive with later roadmap items.
      </p>
      <p className="app-shell__note">
        Linked workspace package: <code>@jonny-boi/{CORE_PACKAGE_NAME}</code>
      </p>
    </main>
  );
}
