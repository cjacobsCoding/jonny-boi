import { PACKAGE_NAME as CORE_PACKAGE_NAME } from '@jonny-boi/core';

/**
 * Placeholder export. The headless runMatch/runGauntlet harness, the reporter
 * registry, and A/B statistics land in roadmap item §3.5. Re-exporting through
 * core proves the cross-package workspace import resolves.
 */
export const PACKAGE_NAME = 'sim';

/** The core package this harness drives, surfaced for the scaffold smoke test. */
export const CORE_DEPENDENCY = CORE_PACKAGE_NAME;
