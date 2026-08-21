/** SCRATCH — trace the re-aim choice inside the loop. */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { GameAction, Pilot } from '@jonny-boi/core';
import { buildMixedDeck, indexPoolForSoak } from './soak-decks.js';
import { loadDeck } from './deck.js';
import { makeSeats } from './matchup.js';
import { runMatch } from './match.js';
import { soakSimConfig } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const base = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
const index = indexPoolForSoak(pool.cards);

const CASES = [
  { seed: 3434778477, onPlay: 'B' as const },
  { seed: 1390617766, onPlay: 'A' as const },
  { seed: 113343071, onPlay: 'A' as const },
];

describe('trace', () => {
  for (const { seed, onPlay } of CASES) {
    it(`seed ${seed} onPlay=${onPlay}`, () => {
      const sim = soakSimConfig();
      const deckA = buildMixedDeck(index, seed);
      const deckB = buildMixedDeck(index, seed ^ 0x27d4eb2f);
      let n = 0;
      const log: string[] = [];
      const pilot: Pilot = {
        ...base,
        chooseAction(ctx): GameAction {
          const st: any = ctx.view;
          const pc = st.pendingChoice;
          if (pc && pc.kind === 'selectTargets' && String(pc.prompt).includes('new targets')) {
            n++;
            if (n <= 6 || n % 400 === 0) {
              log.push(`--- reaim #${n} turn=${st.turnNumber} step=${st.step}`);
              log.push(`    prompt: ${pc.prompt}`);
              log.push(`    candidates: ${JSON.stringify(pc.candidates)}`);
              log.push(`    stack: ${JSON.stringify(st.stack.map((o: any) => ({ id: o.instanceId, kind: o.kind, name: o.card?.def?.name ?? o.name, ctrl: o.controller, targets: o.targets, copy: o.isSpellCopy })))}`);
              log.push(`    resolution: next=${st.resolution?.next} targets=${JSON.stringify(st.resolution?.targets)} effTargets=${JSON.stringify(st.resolution?.effectTargets)} src=${st.resolution?.source?.def?.name ?? st.resolution?.sourceInstanceId}`);
              const a = base.chooseAction(ctx);
              log.push(`    -> answer ${JSON.stringify(a)}`);
              return a;
            }
          }
          return base.chooseAction(ctx);
        },
      };
      const seats = makeSeats(loadDeck(deckA, pool), loadDeck(deckB, pool), { pilotA: pilot, pilotB: pilot }, registry);
      const r = runMatch(seats, seed, { sim, startingPlayer: onPlay });
      console.log(`\n### seed ${seed} onPlay=${onPlay}: actions=${r.actions} turns=${r.turns} reaims=${n}`);
      console.log(log.join('\n'));
      expect(r.actions).toBeLessThan(6000);
    }, 300_000);
  }
});
