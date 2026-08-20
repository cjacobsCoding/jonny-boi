/** BOOTSTRAP — replaced by the real manifest once the drift survey is done. */
export const CONFORMANCE_FILES = [
  'cr1xx-2xx-objects',
  'cr4xx-zones',
  'cr5xx-turn-and-combat',
  'cr6xx-spells-and-abilities',
] as const;
export type ConformanceFile = (typeof CONFORMANCE_FILES)[number];
export function coveredTitlesForFile(_file: ConformanceFile): readonly string[] {
  return [];
}
