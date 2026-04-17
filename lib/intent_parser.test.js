/**
 * functions/lib/intent_parser.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manual test suite for parseIntentLocal.
 * No test framework required — run with Node.js directly:
 *
 *   node functions/lib/intent_parser.test.js
 *
 * Exit code 0 = all tests passed, non-zero = failures.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseIntentLocal } from './intent_parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, question, bookHint, expected) {
  const result = parseIntentLocal(question, bookHint);
  const failures = [];

  for (const [key, value] of Object.entries(expected)) {
    const got = result[key];
    // null matches null strictly; strings are case-insensitive
    const match = value === null
      ? got === null
      : String(got).toLowerCase() === String(value).toLowerCase();

    if (!match) {
      failures.push(`  ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`);
    }
  }

  if (failures.length === 0) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}`);
    failures.forEach(f => console.log(f));
    console.log(`        Full result: ${JSON.stringify(result)}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Language detection ──────────────────────────────────────────');

test('FR: explicit French words',
  'Quels sont les ennemis de Hari Seldon dans PAF ?', 'all',
  { language: 'fr' });

test('EN: explicit English words',
  'Who are Baley\'s allies in LCA?', 'all',
  { language: 'en' });

test('Short ambiguous → defaults to fr',
  'Baley LCA', 'all',
  { language: 'fr' });

console.log('\n── Book detection ──────────────────────────────────────────────');

test('FR: "dans PAF"',
  'Quels sont les ennemis de Hari Seldon dans PAF ?', 'all',
  { book: 'paf' });

test('FR: "Les Cavernes d\'Acier"',
  "Résume les personnages des Cavernes d'Acier", 'all',
  { book: 'lca' });

test('EN: "in lca"',
  'Who are the most central characters in lca?', 'all',
  { book: 'lca' });

test('EN: "Caves of Steel"',
  'Show me the network in the Caves of Steel', 'all',
  { book: 'lca' });

test('EN: "Prelude to Foundation"',
  'Stats for Prelude to Foundation', 'all',
  { book: 'paf' });

test('bookHint applied when no book in text',
  'Who are the most connected characters?', 'lca',
  { book: 'lca' });

test('No book → all',
  'Donne-moi les personnages les plus connectés', 'all',
  { book: 'all' });

console.log('\n── Chapter detection ───────────────────────────────────────────');

test('FR: "chapitre 5"',
  'Stats du chapitre 5 dans PAF', 'all',
  { chapter: 5 });

test('EN: "chapter 12"',
  'Stats for chapter 12 in lca', 'all',
  { chapter: 12 });

test('No chapter → null',
  'Quels sont les ennemis de Hari Seldon ?', 'all',
  { chapter: null });

console.log('\n── Polarity detection ──────────────────────────────────────────');

test('FR: "ennemis"',
  'Quels sont les ennemis de Baley ?', 'all',
  { polarity: 'ennemi' });

test('FR: "amis"',
  'Qui sont les amis de Seldon ?', 'all',
  { polarity: 'ami' });

test('FR: "alliés"',
  'Liste les alliés de Daneel dans LCA', 'all',
  { polarity: 'ami' });

test('FR: "hostile"',
  'Quels personnages sont hostiles à Hummin ?', 'all',
  { polarity: 'ennemi' });

test('FR: "neutre"',
  'Relations neutres de Dors dans PAF', 'all',
  { polarity: 'neutre' });

test('EN: "enemies"',
  'Who are the enemies of Hari Seldon?', 'all',
  { polarity: 'ennemi' });

test('EN: "ally"',
  "Who is Baley's ally?", 'all',
  { polarity: 'ami' });

test('No polarity → null',
  'Quels sont les personnages les plus connectés dans LCA ?', 'all',
  { polarity: null });

console.log('\n── Intent detection ────────────────────────────────────────────');

test('neighbors_by_polarity — FR enemies',
  'Quels sont les ennemis de Hari Seldon dans PAF ?', 'all',
  { intent: 'neighbors_by_polarity' });

test('neighbors_by_polarity — EN allies',
  "Who are Baley's allies in LCA?", 'all',
  { intent: 'neighbors_by_polarity' });

test('neighbors_by_polarity — neutral relations',
  'Liste les relations neutres de Dors dans PAF', 'all',
  { intent: 'neighbors_by_polarity' });

test('relation_between_entities — FR',
  'Quelle est la relation entre Hari Seldon et Dors Venabili ?', 'all',
  { intent: 'relation_between_entities' });

test('relation_between_entities — EN',
  'What is the relationship between Baley and Daneel?', 'all',
  { intent: 'relation_between_entities' });

test('top_central_characters — FR',
  'Quels sont les personnages les plus connectés dans LCA ?', 'all',
  { intent: 'top_central_characters' });

test('top_central_characters — EN',
  'Who are the most central characters in lca?', 'all',
  { intent: 'top_central_characters' });

test('character_summary — FR',
  "Résume les relations de Hummin", 'all',
  { intent: 'character_summary' });

test('character_summary — EN',
  "Give me a summary of Hari Seldon's connections", 'all',
  { intent: 'character_summary' });

test('book_or_chapter_stats — FR',
  'Donne-moi les statistiques de PAF', 'all',
  { intent: 'book_or_chapter_stats' });

test('book_or_chapter_stats — EN chapter',
  'Stats for chapter 12 in lca', 'all',
  { intent: 'book_or_chapter_stats' });

console.log('\n── Entity extraction ───────────────────────────────────────────');

test('FR: "de Hari Seldon"',
  'Quels sont les ennemis de Hari Seldon dans PAF ?', 'all',
  { entity: 'Hari Seldon' });

test('FR: "entre X et Y"',
  'Quelle est la relation entre Hari Seldon et Dors Venabili ?', 'all',
  { entity: 'Hari Seldon', entity_2: 'Dors Venabili' });

test('EN: "between X and Y"',
  'What is the relationship between Baley and Daneel?', 'all',
  { entity: 'Baley', entity_2: 'Daneel' });

test("EN: possessive X's",
  "Who are Baley's allies?", 'all',
  { entity: 'Baley' });

test('Single capitalized name',
  'Qui est Hummin ?', 'all',
  { entity: 'Hummin' });

console.log('\n── Robustness ──────────────────────────────────────────────────');

test('Empty string → fallback',
  '', 'all',
  { intent: 'character_summary', entity: null, entity_2: null, polarity: null, book: 'all' });

test('Null input → fallback',
  null, 'all',
  { intent: 'character_summary', entity: null });

test('Single word — known character',
  'Seldon', 'paf',
  { entity: 'Seldon', book: 'paf' });

test('All caps → still works',
  'WHO ARE THE ENEMIES OF BALEY IN LCA?', 'all',
  { intent: 'neighbors_by_polarity', polarity: 'ennemi', book: 'lca' });

test('Ambiguous / no clear intent',
  'Fondation ?', 'all',
  // Should not crash and should return something sensible
  { book: 'paf' }); // "Fondation" maps to paf

test('Mixed FR/EN question',
  'Donne-moi les allies of Hari Seldon in PAF', 'all',
  { polarity: 'ami', entity: 'Hari Seldon', book: 'paf' });

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n── Results ─────────────────────────────────────────────────────`);
console.log(`  Passed : ${passed}`);
console.log(`  Failed : ${failed}`);
console.log(`  Total  : ${passed + failed}`);
console.log('');

process.exit(failed > 0 ? 1 : 0);
