// Dump, for the given keywords, every card SOLE-blocked by that keyword's printed
// line, with its full Oracle text — ground truth for a worker brief.
// Usage: node keyword-cards.mjs <corpus.json> <keyword> [<keyword>...] [--all]
import { readFileSync } from 'node:fs';
import { normalizeCard } from '@jonny-boi/data-tools';
import { compileCard } from '@jonny-boi/cards';

const [corpusPath, ...rest] = process.argv.slice(2);
const all = rest.includes('--all');
const keywords = rest.filter((k) => !k.startsWith('--')).map((k) => k.toLowerCase());
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REASON = /^the "(.+)" keyword ability$/;
const PARAM = /\s+(?:\d.*|\{.*|for\s+.*|from\s+.*|—.*)$/i;
const mech = (p) => p.replace(PARAM, '').trim().toLowerCase();

const out = new Map(keywords.map((k) => [k, { sole: [], multi: [] }]));
for (const raw of corpus) {
  let r;
  try { r = compileCard(normalizeCard(raw)); } catch { continue; }
  if (r.status === 'complete') continue;
  const missing = r.missing ?? [];
  const tags = Array.isArray(raw.keywords) ? raw.keywords : [];
  const hit = new Set();
  for (const e of missing) {
    const swept = REASON.exec(e.missingEngineSystem ?? '');
    if (swept) { hit.add(mech(swept[1])); continue; }
    const clause = (e.text ?? '').toLowerCase();
    for (const t of tags) if (new RegExp(`^${escapeRegExp(t.toLowerCase())}\\b`).test(clause)) hit.add(mech(t));
  }
  for (const k of hit) {
    if (!out.has(k)) continue;
    (missing.length === 1 ? out.get(k).sole : out.get(k).multi).push({ raw, missing });
  }
}
for (const [k, { sole, multi }] of out) {
  console.log(`\n===== ${k.toUpperCase()} — sole ${sole.length}, also-blocked ${multi.length} =====`);
  for (const { raw } of sole) {
    console.log(`\n--- ${raw.name} [${raw.mana_cost ?? ''}] ${raw.type_line} ${raw.power ?? ''}${raw.power != null ? '/' + raw.toughness : ''}`);
    console.log(raw.oracle_text ?? '');
  }
  if (all) {
    for (const { raw, missing } of multi) {
      console.log(`\n--- (multi) ${raw.name} [${raw.mana_cost ?? ''}] ${raw.type_line}`);
      console.log(raw.oracle_text ?? '');
      console.log('  other gaps: ' + missing.map((m) => m.text).join(' | '));
    }
  }
}
