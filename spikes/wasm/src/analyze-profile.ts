/**
 * Turn a `node --cpu-prof` `.cpuprofile` into the two tables that actually answer
 * "should we rewrite this in WASM?":
 *
 *   1. **Self time by function** — where the CPU genuinely is, not where the call
 *      tree says the work was requested from. A WASM port only helps functions
 *      with real SELF time.
 *   2. **Self time by bucket** — the same samples grouped into the categories the
 *      decision hinges on: engine logic, state cloning, allocation/GC, pilot
 *      scoring, and V8/runtime builtins (array/object/Map machinery). WASM can
 *      only touch buckets that are OUR code doing arithmetic; time in GC and V8
 *      builtins moves only if the DATA LAYOUT changes, which is a different (and
 *      cheaper) intervention than a language port.
 *
 * The `.cpuprofile` format: `nodes` (id, callFrame, children, optional hitCount),
 * `samples` (node ids, one per sample) and `timeDeltas` (µs before each sample).
 * Self time per node = the sum of the deltas of the samples attributed to it —
 * we use the deltas rather than `hitCount × interval` because the sampler's real
 * interval drifts, and the deltas are the ground truth of the run.
 */

import { readFileSync } from 'node:fs';

interface CallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
}
interface ProfileNode {
  readonly id: number;
  readonly callFrame: CallFrame;
  readonly children?: readonly number[];
}
interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

/** One reported row: a function (or bucket) and the microseconds of SELF time in it. */
export interface SelfTimeRow {
  readonly label: string;
  readonly selfMicros: number;
  readonly percent: number;
}

/**
 * The buckets the WASM decision is made in. Order matters — the first matching
 * rule wins — so the specific rules (clone, continuous) precede the general
 * "anything else in core" rule.
 */
interface Bucket {
  readonly name: string;
  readonly matches: (frame: CallFrame) => boolean;
}

const inFile = (frame: CallFrame, needle: string): boolean => frame.url.includes(needle);

const BUCKETS: readonly Bucket[] = [
  {
    name: 'GC + allocation (V8)',
    matches: (f) =>
      f.url === '' &&
      /^(\(garbage collector\)|\(program\)|GC|Allocate)/.test(f.functionName),
  },
  { name: 'core: cloneState', matches: (f) => inFile(f, 'core') && inFile(f, 'clone') },
  {
    name: 'core: continuous-effects layering',
    matches: (f) => inFile(f, 'core') && (inFile(f, 'continuous') || inFile(f, 'statics') || inFile(f, 'stats')),
  },
  { name: 'core: combat', matches: (f) => inFile(f, 'core') && inFile(f, 'combat') },
  { name: 'core: mana + payment', matches: (f) => inFile(f, 'core') && inFile(f, 'mana') },
  { name: 'core: engine (actions, priority, stack)', matches: (f) => inFile(f, 'core') && inFile(f, 'engine') },
  { name: 'core: other', matches: (f) => inFile(f, '/core/') || inFile(f, '\\core\\') },
  { name: 'ai: pilot scoring', matches: (f) => inFile(f, '/ai/') || inFile(f, '\\ai\\') },
  { name: 'cards: effect primitives', matches: (f) => inFile(f, '/cards/') || inFile(f, '\\cards\\') },
  { name: 'sim: harness', matches: (f) => inFile(f, '/sim/') || inFile(f, '\\sim\\') },
  { name: 'node internals / tooling', matches: (f) => f.url.startsWith('node:') || inFile(f, 'node_modules') },
  { name: 'V8 builtins (unattributed)', matches: (f) => f.url === '' },
];

function bucketFor(frame: CallFrame): string {
  for (const b of BUCKETS) if (b.matches(frame)) return b.name;
  return 'other';
}

/** Short, readable name for a call frame: `functionName (file:line)`. */
function labelFor(frame: CallFrame): string {
  const file = frame.url === '' ? '<v8>' : (frame.url.split(/[/\\]/).pop() ?? frame.url);
  const name = frame.functionName === '' ? '(anonymous)' : frame.functionName;
  return `${name} (${file}:${frame.lineNumber + 1})`;
}

export interface ProfileAnalysis {
  readonly totalMicros: number;
  readonly byFunction: readonly SelfTimeRow[];
  readonly byBucket: readonly SelfTimeRow[];
}

export function analyzeProfile(path: string): ProfileAnalysis {
  const profile = JSON.parse(readFileSync(path, 'utf8')) as CpuProfile;
  const nodeById = new Map<number, ProfileNode>();
  for (const n of profile.nodes) nodeById.set(n.id, n);

  const selfByNode = new Map<number, number>();
  let total = 0;
  // timeDeltas[i] is the time BEFORE samples[i]; attribute it to samples[i].
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i] as number;
    const delta = Math.max(0, (profile.timeDeltas[i] as number) ?? 0);
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + delta);
    total += delta;
  }

  const byFunctionMap = new Map<string, number>();
  const byBucketMap = new Map<string, number>();
  for (const [id, micros] of selfByNode) {
    const node = nodeById.get(id);
    if (!node) continue;
    const label = labelFor(node.callFrame);
    byFunctionMap.set(label, (byFunctionMap.get(label) ?? 0) + micros);
    const bucket = bucketFor(node.callFrame);
    byBucketMap.set(bucket, (byBucketMap.get(bucket) ?? 0) + micros);
  }

  const toRows = (m: Map<string, number>): SelfTimeRow[] =>
    [...m.entries()]
      .map(([label, selfMicros]) => ({ label, selfMicros, percent: (selfMicros / total) * 100 }))
      .sort((a, b) => b.selfMicros - a.selfMicros);

  return { totalMicros: total, byFunction: toRows(byFunctionMap), byBucket: toRows(byBucketMap) };
}

function formatRows(rows: readonly SelfTimeRow[], limit: number): string {
  return rows
    .slice(0, limit)
    .map((r) => `  ${r.percent.toFixed(2).padStart(6)}%  ${(r.selfMicros / 1000).toFixed(1).padStart(9)} ms  ${r.label}`)
    .join('\n');
}

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: analyze-profile <file.cpuprofile> [topN]\n');
  process.exit(2);
}
const topN = Number(process.argv[3] ?? '30');
const analysis = analyzeProfile(path);
process.stdout.write(`Profile: ${path}\nTotal sampled CPU: ${(analysis.totalMicros / 1000).toFixed(1)} ms\n\n`);
process.stdout.write(`=== SELF TIME BY BUCKET ===\n${formatRows(analysis.byBucket, 40)}\n\n`);
process.stdout.write(`=== SELF TIME BY FUNCTION (top ${topN}) ===\n${formatRows(analysis.byFunction, topN)}\n`);
