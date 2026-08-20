import { describe, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import type { GameEvent, GameState } from '@jonny-boi/core';
import { indexContinuous, NO_MOD, effectiveToughness, checkStateBasedActions, stateBasedActionsPossible } from '@jonny-boi/core';
import { buildMixedDeck, indexPoolForSoak } from './soak-decks.js';
import { loadDeck } from './deck.js';
import { runMatch } from './match.js';
import { makeSeats } from './matchup.js';

describe('zz repro single game', () => {
  it('dumps', () => {
    const pool = loadCardPool({ onWarn: () => {} });
    const index = indexPoolForSoak(pool.cards);
    const seed = 4222011655;
    const deckA = loadDeck(buildMixedDeck(index, seed), pool);
    const deckB = loadDeck(buildMixedDeck(index, (seed ^ 0x27d4eb2f) | 0), pool);
    const inner = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
    const events: GameEvent[] = [];
    const log: string[] = [];
    (globalThis as any).__SBA_DBG = (st: GameState, where: string) => {
      const inst = st.battlefield.find((i: any) => i.instanceId === 34);
      if (!inst) return;
      const cont = indexContinuous(st);
      const t = effectiveToughness(inst, cont.get(34) ?? NO_MOD);
      const att = st.battlefield.filter((i: any) => i.attachedTo === 34).map((i: any) => i.instanceId + ':' + i.def.name);
      const i84: any = st.battlefield.find((i: any) => i.instanceId === 84);
      const has14 = st.battlefield.some((i: any) => i.instanceId === 14);
      const line = `${where} T${st.turnNumber} ${st.step} has14=${has14} tough=${t} mod=${JSON.stringify(cont.get(34))} attTo34=[${att}] i84=${i84 ? 'bf,attachedTo=' + i84.attachedTo : 'NOT-ON-BF'} defAtt=${JSON.stringify((inst.def as any).attachment)}`;
      if (log[log.length - 1] !== line) log.push(line);
    };
    let dumped = 0;
    const pilot = {
      id: 'dump',
      description: 'dump',
      chooseAction(ctx: any) {
        const st = ctx.view as GameState;
        (globalThis as any).__SBA_DBG(st, 'PILOT-SEES seat=' + st.priorityPlayer);
        if (dumped < 2) {
          const inst = st.battlefield.find((i: any) => i.instanceId === 34);
          if (inst) {
            const cont = indexContinuous(st);
            const tough = effectiveToughness(inst, cont.get(34) ?? NO_MOD);
            if (tough <= 0 && st.pendingChoice == null && st.resolution == null) {
              dumped++;
              console.log('=== BA34 tough', tough, 'turn', st.turnNumber, 'step', st.step);
              console.log('inst', JSON.stringify(inst, null, 1));
              console.log('mod', JSON.stringify(cont.get(34)));
              console.log('attached-to-34', JSON.stringify(
                st.battlefield.filter((i: any) => i.attachedTo === 34).map((i: any) => ({ id: i.instanceId, n: i.def.name, ctrl: i.controller })),
              ));
              console.log('battlefield', JSON.stringify(st.battlefield.map((i: any) => `${i.instanceId}:${i.def.name}${i.attachedTo != null ? '->' + i.attachedTo : ''}`)));
              console.log('SBA LOG (deduped consecutive):');
              for (const l of log.slice(-60)) console.log('   ' + l);
              console.log('GATE stateBasedActionsPossible =', stateBasedActionsPossible(st));
              const before = st.battlefield.length;
              const emitted: any[] = [];
              checkStateBasedActions(st, (e) => emitted.push(e));
              console.log('AFTER running the pass by hand: battlefield', before, '->', st.battlefield.length,
                'still34=', st.battlefield.some((i: any) => i.instanceId === 34), 'emitted=', JSON.stringify(emitted));
              console.log('RELEVANT EVENTS');
              let turn = 0;
              for (const e of events) {
                const a = e as any;
                if (a.type === 'turnBegin') { turn = a.turnNumber ?? turn + 1; }
                if (a.instanceId === 34 || a.instanceId === 84 || a.sourceInstanceId === 34 || a.sourceInstanceId === 84 || a.targetInstanceId === 34 || a.targetInstanceId === 84 || a.type === 'turnBegin' || a.type === 'stepBegin')
                  console.log('  T' + turn + ' ' + JSON.stringify(e));
              }
            }
          }
        }
        const a = inner.chooseAction(ctx);
        (globalThis as any).__SBA_DBG(st, 'ACTION=' + JSON.stringify(a));
        return a;
      },
    } as any;
    const seats = makeSeats(deckA, deckB, { pilotA: pilot, pilotB: pilot }, buildRegistry());
    runMatch(seats, seed, { startingPlayer: 'A', onEvent: (e) => events.push(e) });
  }, 0);
});
