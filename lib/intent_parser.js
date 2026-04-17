/**
 * functions/lib/intent_parser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rule-based intent parser for the Foundation Graph application.
 * Bilingual (French / English). Zero external dependencies. Zero API calls.
 *
 * Public API:
 *   parseIntentLocal(question: string, bookHint?: string) → IntentObject
 *
 * IntentObject shape:
 *   {
 *     language : "fr" | "en",
 *     intent   : "neighbors_by_polarity" | "relation_between_entities" |
 *                "top_central_characters" | "character_summary" |
 *                "book_or_chapter_stats",
 *     entity   : string | null,   -- raw candidate, resolved later by findEntityId
 *     entity_2 : string | null,
 *     polarity : "ami" | "ennemi" | "neutre" | null,
 *     book     : "lca" | "paf" | "all",
 *     chapter  : number | null,
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_INTENTS = [
  'neighbors_by_polarity',
  'relation_between_entities',
  'top_central_characters',
  'character_summary',
  'book_or_chapter_stats',
];

const FALLBACK_INTENT = {
  language : 'fr',
  intent   : 'character_summary',
  entity   : null,
  entity_2 : null,
  polarity : null,
  book     : 'all',
  chapter  : null,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. LANGUAGE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// A small set of high-frequency French function words that rarely appear in
// English text. Enough to distinguish the two languages reliably.
const FR_MARKERS = [
  'le', 'la', 'les', 'des', 'du', 'un', 'une', 'dans', 'est', 'sont',
  'qui', 'que', 'quel', 'quelle', 'quels', 'quelles', 'avec', 'entre',
  'plus', 'moi', 'donne', 'quels', 'quel', 'donne',
];

/**
 * Detect the language of the question.
 * Returns 'fr' or 'en'. Defaults to 'fr' when ambiguous
 * (most users are French-speaking in this context).
 *
 * @param {string} text
 * @returns {"fr"|"en"}
 */
export function detectLanguage(text) {
  if (!text) return 'fr';
  const words = text.toLowerCase().split(/\s+/);

  const frCount = words.filter(w => FR_MARKERS.includes(w)).length;
  if (frCount >= 1) return 'fr';

  // Only classify as English if we see unambiguous EN-only markers
  const EN_ONLY = ['the', 'are', 'who', 'what', 'is', 'how', 'where', 'when',
                   'their', 'does', 'did', 'was', 'were', 'give', 'show',
                   'tell', 'list', 'find', 'get', 'between', 'and', 'of'];
  const enCount = words.filter(w => EN_ONLY.includes(w)).length;

  return enCount >= 1 ? 'en' : 'fr'; // default fr
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. BOOK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// Each entry: [regex to match, canonical book key]
// Order matters: more specific patterns first.
const BOOK_PATTERNS = [
  // Explicit abbreviations (exact word boundary)
  [/\blca\b/i,                                    'lca'],
  [/\bpaf\b/i,                                    'paf'],
  // French full names
  [/cavernes?\s+d['']acier/i,                     'lca'],
  [/pr[eé]lude\s+[aà]\s+(?:la\s+)?fondation/i,   'paf'],
  // English full names
  [/caves?\s+of\s+steel/i,                        'lca'],
  [/prelude\s+to\s+(?:the\s+)?foundation/i,       'paf'],
  // Partials (last resort — only if nothing else matched)
  [/\bcavernes?\b/i,                              'lca'],
  [/\bpr[eé]lude\b/i,                             'paf'],
  [/\bprelude\b/i,                                'paf'],
  [/\bfondation\b/i,                              'paf'],
  [/\bfoundation\b/i,                             'paf'],
];

/**
 * Detect the book corpus from the question text.
 * bookHint is applied when no book is found in the text.
 *
 * @param {string} text
 * @param {string} [bookHint] - 'lca' | 'paf' | 'all' — from the UI filter
 * @returns {"lca"|"paf"|"all"}
 */
export function detectBook(text, bookHint) {
  if (!text) return bookHint || 'all';

  for (const [pattern, book] of BOOK_PATTERNS) {
    if (pattern.test(text)) return book;
  }

  // Fall back to the UI filter, then 'all'
  if (bookHint && bookHint !== 'all') return bookHint;
  return 'all';
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CHAPTER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// Matches: "chapitre 5", "chapter 12", "ch. 3", "ch3"
const CHAPTER_PATTERN = /\b(?:chapitre[s]?|chapter[s]?|ch\.?)\s*(\d+)\b/i;

/**
 * Extract the chapter number from the text, or null.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function detectChapter(text) {
  if (!text) return null;
  const match = text.match(CHAPTER_PATTERN);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return isNaN(n) ? null : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. POLARITY DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// Pairs: [regex, canonical polarity]
// 'ennemi' and 'ami' checked before 'neutre' to avoid false positives.
const POLARITY_PATTERNS = [
  // Negative / enemy
  [/\b(?:ennemi[se]?|hostile[s]?|adversaire[s]?|n[eé]gatif[s]?|n[eé]gative[s]?|enem(?:y|ies)|foe[s]?|antagoniste[s]?)\b/i, 'ennemi'],
  // Positive / ally
  [/\b(?:ami[se]?|alli[eé][s]?|positif[s]?|positive[s]?|friend[s]?|ally|allies|proche[s]?|favorable[s]?)\b/i,              'ami'],
  // Neutral
  [/\b(?:neutre[s]?|neutral[s]?|indiff[eé]rent[s]?)\b/i,                                                                    'neutre'],
];

/**
 * Detect the polarity filter from the text.
 * Returns "ami", "ennemi", "neutre", or null.
 *
 * @param {string} text
 * @returns {"ami"|"ennemi"|"neutre"|null}
 */
export function detectPolarity(text) {
  if (!text) return null;
  for (const [pattern, polarity] of POLARITY_PATTERNS) {
    if (pattern.test(text)) return polarity;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. INTENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// Each rule: { intent, patterns[] }
// First match wins. Order = priority.
const INTENT_RULES = [
  {
    intent: 'relation_between_entities',
    patterns: [
      // French
      /\brelation\s+entre\b/i,
      /\blien\s+entre\b/i,
      /\brapport\s+entre\b/i,
      /\bliens?\s+qui\s+unit\b/i,
      /\bcomment\s+.{1,40}\s+(?:se\s+rapport|interagit|connai)/i,
      // English
      /\brelationship\s+between\b/i,
      /\blink\s+between\b/i,
      /\bconnection\s+between\b/i,
      /\bhow\s+.{1,30}\s+(?:relate|interact|know)/i,
    ],
  },
  {
    intent: 'top_central_characters',
    patterns: [
      // French
      /\bpersonnages?\s+les\s+plus\s+(?:connect|central|important|influent)/i,
      /\bplus\s+(?:connect|central|important|influent)/i,
      /\bhub[s]?\b/i,
      /\bclassement\s+(?:des\s+)?personnage/i,
      /\bqui\s+(?:sont|est)\s+le[s]?\s+plus\s+(?:connect|central|present|influent)/i,
      // English
      /\bmost\s+(?:connect|central|important|influent|present)/i,
      /\bmain\s+character/i,
      /\btop\s+\d*\s*character/i,
      /\bwho\s+(?:are|is)\s+the\s+most\b/i,
    ],
  },
  {
    intent: 'book_or_chapter_stats',
    patterns: [
      // French
      /\bstatistiques?\b/i,
      /\bstats?\b/i,
      /\bcombien\s+(?:de\s+)?(?:personnage|lien|noeud|edge|node|relation)/i,
      /\bdensit[eé]\b/i,
      /\banalyse\s+(?:du\s+)?(?:graphe|chapitre|corpus)/i,
      // English
      /\bhow\s+many\b/i,
      /\bgraph\s+(?:statistics|stats|metrics|analysis)\b/i,
    ],
  },
  {
    intent: 'neighbors_by_polarity',
    patterns: [
      // French — polarity-first formulations
      /\bennemis?\s+(?:de|d['''])/i,
      /\bamis?\s+(?:de|d['''])/i,
      /\balli[eé]s?\s+(?:de|d['''])/i,
      /\brelations?\s+(?:ami|ennemi|neutre|hostile|positif|n[eé]gatif)/i,
      /\bcontacts?\s+(?:ami|ennemi|neutre)/i,
      /\bliste[r]?\s+les\s+(?:ami|ennemi|relation|lien)/i,
      /\bqui\s+(?:sont|est)\s+(?:l(?:es|[ea'])\s+)?(?:ennemis?|amis?|alliés?|hostile)/i,
      // English — polarity-first formulations
      /\b(?:enemy|enemies|foe[s]?)\s+of\b/i,
      /\b(?:friend[s]?|ally|allies)\s+of\b/i,
      /\bwho\s+(?:are|is)\s+.{0,30}(?:enemy|enemies|ally|allies|friend|foe)/i,
    ],
  },
  {
    intent: 'character_summary',
    patterns: [
      // French
      /\br[eé]sum[eé]\b/i,
      /\bparle[r]?\s+(?:moi\s+)?(?:de|du|d['''])/i,
      /\bprofil\b/i,
      /\bqui\s+est\b/i,
      /\bd[eé]cri[st]\b/i,
      // English
      /\bsummary\s+of\b/i,
      /\btell\s+me\s+about\b/i,
      /\bwho\s+is\b/i,
      /\bdescribe\b/i,
      /\bprofile\s+of\b/i,
      /\bconnections?\s+of\b/i,
    ],
  },
];

/**
 * Detect the intent from the question text.
 * Uses secondary heuristics when no pattern matches.
 *
 * @param {string} text
 * @param {string|null} polarity  - already-detected polarity
 * @param {string|null} entity    - already-detected primary entity
 * @param {string|null} entity_2  - already-detected secondary entity
 * @returns {string}
 */
export function detectIntent(text, polarity, entity, entity_2) {
  if (!text) return 'character_summary';

  // Pattern matching (first rule wins)
  for (const { intent, patterns } of INTENT_RULES) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return intent;
    }
  }

  // Secondary heuristics when no pattern matched
  if (entity_2)          return 'relation_between_entities';
  if (polarity && entity) return 'neighbors_by_polarity';
  if (entity)             return 'character_summary';

  // Default: show top characters — useful for very short/vague queries
  return 'top_central_characters';
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. ENTITY EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

// Words to strip before/after a candidate entity name.
// These are structural words that appear around entity mentions.
const STOPWORDS = new Set([
  // French
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'au', 'aux',
  'et', 'ou', 'en', 'dans', 'sur', 'par', 'pour', 'avec', 'sans',
  'est', 'sont', 'a', 'ont', 'se', 'me', 'te', 'lui', 'leur', 'leurs',
  'qui', 'que', 'quoi', 'dont', 'quel', 'quelle', 'quels', 'quelles',
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'mon', 'ton', 'son', 'ma', 'ta', 'sa', 'mes', 'tes', 'ses',
  'moi', 'toi', 'soi',
  // Verbs commonly found around names in questions
  'connais', 'connait', 'sait', 'savoir', 'donne', 'donner', 'liste',
  'lister', 'montre', 'montrer', 'cherche', 'chercher', 'trouve', 'trouver',
  'resume', 'resumer', 'parle', 'parler', 'decris', 'decrire',
  // English
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with',
  'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'who', 'what', 'when', 'where', 'which', 'how',
  'me', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'all', 'some',
  // Question words
  'quels', 'quelle', 'quelles', 'comment', 'pourquoi', 'combien',
  // Domain words not to extract as entities
  'personnage', 'personnages', 'character', 'characters',
  'relation', 'relations', 'relationship', 'lien', 'liens',
  'graphe', 'graph', 'corpus', 'chapitre', 'chapter',
  'ami', 'amis', 'ennemi', 'ennemis', 'neutre', 'neutres',
  'ally', 'allies', 'enemy', 'enemies', 'friend', 'friends',
  'paf', 'lca', 'all',
]);

// Patterns to capture entities from structured positional markers.
// Each pattern: [regex, group index for entity1, group index for entity2 or null]
const ENTITY_STRUCTURAL_PATTERNS = [
  // French: "entre X et Y"
  { re: /\bentre\s+([^,?]+?)\s+et\s+([^,?]+?)(?:\s*[?!,.]|$)/i,    g1: 1, g2: 2 },
  // English: "between X and Y"
  { re: /\bbetween\s+([^,?]+?)\s+and\s+([^,?]+?)(?:\s*[?!,.]|$)/i, g1: 1, g2: 2 },
  // French: "de X" / "d'X"
  { re: /\b(?:de|d['''])\s+([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-Za-zÀ-öø-ÿ\s\-]{1,40}?)(?=\s*(?:dans|en|sur|au|avec|et|ou|[?!,.]|$))/u, g1: 1, g2: null },
  // English: "of X", "for X"
  { re: /\b(?:of|for|about)\s+([A-Z][A-Za-z\s\-]{1,40}?)(?=\s*(?:in|at|with|and|or|[?!,.]|$))/u, g1: 1, g2: null },
  // Possessive: "Baley's ..." — only matches 1-2 capitalized words, no spaces in class
  { re: /\b([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-Za-zÀ-öø-ÿ\-]{1,25}(?:\s[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][A-Za-zÀ-öø-ÿ\-]+)?)[''']s\b/u, g1: 1, g2: null },
];

/**
 * Clean a raw candidate string:
 * - trim whitespace
 * - remove surrounding punctuation and quotes
 * - normalize internal whitespace
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanCandidate(raw) {
  return raw
    .trim()
    .replace(/^[«"''\s]+|[»"''\s.!?,]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a string is too short or is a stopword to be a valid entity.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isValidCandidate(candidate) {
  if (!candidate || candidate.length < 2) return false;
  // Reject if every word is a stopword
  const words = candidate.toLowerCase().split(/\s+/);
  return words.some(w => !STOPWORDS.has(w));
}

/**
 * Extract up to two character entity candidates from the question.
 * Strategy:
 *   1. Try structural patterns (positional markers like "entre X et Y")
 *   2. Fall back to extracting sequences of capitalized words
 *
 * The caller (findEntityId) performs the actual resolution against the graph.
 *
 * @param {string} text
 * @returns {[string|null, string|null]}
 */
export function extractEntities(text) {
  if (!text) return [null, null];

  // Strategy 1: structural pattern matching
  for (const { re, g1, g2 } of ENTITY_STRUCTURAL_PATTERNS) {
    const match = text.match(re);
    if (!match) continue;

    const e1 = g1 != null ? cleanCandidate(match[g1] ?? '') : null;
    const e2 = g2 != null ? cleanCandidate(match[g2] ?? '') : null;

    if (isValidCandidate(e1)) {
      return [e1, isValidCandidate(e2) ? e2 : null];
    }
  }

  // Strategy 2: extract sequences of title-cased words (proper noun heuristic)
  // Matches runs of 1-4 capitalized words, e.g. "Hari Seldon", "Dors Venabili"
  const properNounRe = /\b([A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][a-zàâäéèêëîïôùûü]+(?:\s+[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜ][a-zàâäéèêëîïôùûü]+){0,3})/gu;
  const candidates = [];

  for (const m of text.matchAll(properNounRe)) {
    const c = cleanCandidate(m[1]);
    if (isValidCandidate(c)) {
      candidates.push(c);
    }
  }

  // Deduplicate while preserving order
  const seen  = new Set();
  const dedup = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (!seen.has(key)) { seen.add(key); dedup.push(c); }
  }

  return [dedup[0] ?? null, dedup[1] ?? null];
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. MAIN PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a natural-language question into a structured intent object.
 *
 * This function is pure (no side effects, no I/O, no async).
 * It never throws: all errors produce a valid fallback object.
 *
 * @param {string}  question  - The raw user question
 * @param {string}  [bookHint] - Optional book filter from the UI ('lca'|'paf'|'all')
 * @returns {IntentObject}
 */
export function parseIntentLocal(question, bookHint = 'all') {
  // Guard: empty or non-string input → clean fallback
  if (!question || typeof question !== 'string') {
    return { ...FALLBACK_INTENT, book: bookHint || 'all' };
  }

  const q = question.trim();
  if (q.length === 0) {
    return { ...FALLBACK_INTENT, book: bookHint || 'all' };
  }

  try {
    const language = detectLanguage(q);
    const book     = detectBook(q, bookHint);
    const chapter  = detectChapter(q);
    const polarity = detectPolarity(q);
    const [entity, entity_2] = extractEntities(q);
    const intent   = detectIntent(q, polarity, entity, entity_2);

    return { language, intent, entity, entity_2, polarity, book, chapter };

  } catch (err) {
    // Should never happen, but defensive catch to guarantee a valid return
    console.error('[parseIntentLocal] unexpected error:', err.message);
    return { ...FALLBACK_INTENT, book: bookHint || 'all' };
  }
}
