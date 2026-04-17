/**
 * functions/api/query.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare Pages Function — POST /api/query
 *
 * Pipeline:
 *   1. Parse question → structured intent JSON via Gemini Flash
 *   2. Fetch flat JSON data from static assets
 *   3. Execute query locally against the data
 *   4. Generate a natural-language answer via Gemini (grounded in the results)
 *
 * Required environment variable:
 *   GEMINI_API_KEY  — your Google AI Studio key
 * ─────────────────────────────────────────────────────────────────────────────
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body     = await request.json();
    const question = (body.question || '').trim();
    const bookHint = (body.book || 'all').trim();

    if (!question) {
      return jsonResponse({ error: 'Empty question.' }, 400, corsHeaders);
    }

    const GEMINI_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_KEY) {
      return jsonResponse({ error: 'GEMINI_API_KEY not configured.' }, 500, corsHeaders);
    }

    // ── Step 1: Parse intent (rule-based, no API call) ──────────────────────
    const intent = parseIntent(question, bookHint);
    console.log('[query] intent:', JSON.stringify(intent));

    // ── Step 2: Load flat data ───────────────────────────────────────────────
    // Use the Cloudflare ASSETS binding when available (Pages Functions native).
    // Falls back to a regular HTTP fetch for local dev (wrangler pages dev).
    const origin = new URL(request.url).origin;
    const [edgesData, nodesData] = await Promise.all([
      fetchAsset(context, `${origin}/data/edges_flat.json`),
      fetchAsset(context, `${origin}/data/nodes_flat.json`),
    ]);

    if (!Array.isArray(edgesData) || !Array.isArray(nodesData)) {
      throw new Error('Invalid data format: edges or nodes are not arrays.');
    }

    console.log(`[query] loaded ${edgesData.length} edges, ${nodesData.length} node entries`);

    // ── Step 3: Execute query ───────────────────────────────────────────────
    const results = executeQuery(intent, edgesData, nodesData);
    console.log(`[query] query returned ${results.length} results`);

    // ── Step 4: Generate answer ─────────────────────────────────────────────
    const answer = await generateAnswer(GEMINI_KEY, question, intent, results);

    return jsonResponse({ answer, intent, results }, 200, corsHeaders);

  } catch (err) {
    console.error('[query] error:', err.message, err.stack);
    return jsonResponse({ error: err.message || 'Internal error.' }, 500, corsHeaders);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Rule-based intent parser (no LLM call, instant, free)
//
// Replaces the previous Gemini-based parseIntent. Handles all query patterns
// observed in the application without consuming any API quota.
// ─────────────────────────────────────────────────────────────────────────────

// Known character names and their canonical form.
// Covers both French and English variants found in the corpus.
const ENTITY_ALIASES = {
  // PAF characters
  'hari seldon':        'Hari Seldon',
  'seldon':             'Hari Seldon',
  'hari':               'Hari Seldon',
  'dors venabili':      'Dors Venabili',
  'dors':               'Dors Venabili',
  'venabili':           'Dors Venabili',
  'hummin':             'Hummin',
  'chetter hummin':     'Hummin',
  'demerzel':           'Demerzel',
  'eto demerzel':       'Demerzel',
  'cleon':              'Cléon',
  'cléon':              'Cléon',
  "cléon ier":          'Cléon',
  'emperor':            'Cléon',
  'empereur':           'Cléon',
  'amaryl':             'Amaryl',
  'yugo amaryl':        'Amaryl',
  'raych':              'Raych',
  'leggen':             'Leggen',
  'jenarr leggen':      'Leggen',
  'tisalver':           'Tisalver',
  'davan':              'Davan',
  'rachelle':           'Rachelle',
  'mannix':             'Mannix',
  // LCA characters
  'baley':              'Baley',
  'elijah baley':       'Baley',
  'elijah':             'Baley',
  'lije':               'Baley',
  'daneel':             'Daneel',
  'r. daneel':          'Daneel',
  'daneel olivaw':      'Daneel',
  'olivaw':             'Daneel',
  'enderby':            'Enderby',
  'julius enderby':     'Enderby',
  'julius':             'Enderby',
  'fastolfe':           'Fastolfe',
  'dr fastolfe':        'Fastolfe',
  'sarton':             'Sarton',
  'dr sarton':          'Sarton',
  'clousarr':           'Clousarr',
  'francis clousarr':   'Clousarr',
  'jessie':             'Jessie',
  'bentley':            'Bentley',
  'sammy':              'Sammy',
  'r. sammy':           'Sammy',
  'gerrigel':           'Gerrigel',
};

// Book name variants → canonical key
const BOOK_ALIASES = {
  'lca': 'lca', 'les cavernes': 'lca', "cavernes d'acier": 'lca',
  'the caves': 'lca', 'caves of steel': 'lca', 'caves': 'lca',
  'paf': 'paf', 'prelude': 'paf', 'prélude': 'paf',
  'fondation': 'paf', 'foundation': 'paf',
  'prelude to foundation': 'paf', 'prélude à fondation': 'paf',
};

// Polarity keywords in both languages
const POLARITY_PATTERNS = {
  ami:     /\b(ami[se]?|all(y|ies)|friend|allie?[ds]?|proche|favorable)\b/i,
  ennemi:  /\b(ennemi[se]?|enem(y|ies)|foe|hostile|adversaire|antagoniste|contre)\b/i,
  neutre:  /\b(neutre?|neutral|indiff[eé]rent)\b/i,
};

// Intent detection patterns
const INTENT_PATTERNS = [
  {
    intent: 'relation_between_entities',
    patterns: [
      /relation\s+entre/i,
      /lien\s+entre/i,
      /rapport\s+entre/i,
      /relationship\s+between/i,
      /link\s+between/i,
      /comment\s+.{1,30}\s+(se\s+rapport|interact|connai)/i,
    ],
  },
  {
    intent: 'top_central_characters',
    patterns: [
      /plus\s+(connect|central|important|influent)/i,
      /most\s+(connect|central|important|influent)/i,
      /personnages?\s+(principal|central|hub|cl[eé])/i,
      /main\s+character/i,
      /qui\s+(sont|est)\s+le[s]?\s+plus/i,
      /top\s+\d*\s*character/i,
      /classement\s+(des\s+)?personnage/i,
    ],
  },
  {
    intent: 'book_or_chapter_stats',
    patterns: [
      /stat[si]/i,
      /statistique/i,
      /combien\s+(de\s+)?(personnage|lien|noeud|edge|node)/i,
      /how\s+many/i,
      /densit[eé]/i,
      /chapitre\s+\d/i,
      /chapter\s+\d/i,
    ],
  },
  {
    intent: 'neighbors_by_polarity',
    patterns: [
      /ennemi[s]?\s+(de|d'|du)/i,
      /ami[s]?\s+(de|d'|du)/i,
      /all(y|ies|ied)\s+of/i,
      /enem(y|ies)\s+of/i,
      /friend[s]?\s+of/i,
      /adversaire[s]?\s+(de|d'|du)/i,
      /qui\s+(sont|est)\s+l[ae]?[s']?\s*(ennemi|ami|hostile|proche)/i,
      /who\s+(are|is)\s+.{0,20}(ally|allies|enemy|enemies|friend|foe)/i,
    ],
  },
  {
    intent: 'character_summary',
    patterns: [
      /r[eé]sum[eé]/i,
      /summary/i,
      /parle[r]?\s+(moi\s+)?(de|du|d')/i,
      /tell\s+me\s+about/i,
      /qui\s+est/i,
      /who\s+is/i,
      /describe/i,
      /d[eé]cri[st]/i,
      /profil/i,
    ],
  },
];

/**
 * Detect the book from the question text.
 * Returns 'lca', 'paf', bookHint, or 'all'.
 */
function detectBook(text, bookHint) {
  if (bookHint && bookHint !== 'all') return bookHint;
  const lower = text.toLowerCase();
  for (const [alias, book] of Object.entries(BOOK_ALIASES)) {
    if (lower.includes(alias)) return book;
  }
  return 'all';
}

/**
 * Detect the query language (fr / en).
 */
function detectLanguage(text) {
  const frWords = /\b(le|la|les|des|dans|est|sont|quels?|quelle|qui|de|du|un|une|avec|entre|plus)\b/i;
  return frWords.test(text) ? 'fr' : 'en';
}

/**
 * Detect polarity from the question text.
 * Returns 'ami', 'ennemi', 'neutre', or null.
 */
function detectPolarity(text) {
  for (const [label, pattern] of Object.entries(POLARITY_PATTERNS)) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Detect the chapter number if explicitly mentioned.
 * Returns an integer or null.
 */
function detectChapter(text) {
  const match = text.match(/\bchapitre[s]?\s+(\d+)\b|\bchapter\s+(\d+)\b|\bch\.?\s*(\d+)\b/i);
  if (match) {
    const raw = match[1] ?? match[2] ?? match[3];
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Extract character entity names from the question.
 * Returns [entity, entity_2] (may be null).
 */
function extractEntities(text) {
  const lower = text.toLowerCase();
  const found = [];

  // Try known aliases first (longest match wins)
  const sorted = Object.keys(ENTITY_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    if (lower.includes(alias) && !found.includes(ENTITY_ALIASES[alias])) {
      found.push(ENTITY_ALIASES[alias]);
      if (found.length === 2) break;
    }
  }

  return [found[0] ?? null, found[1] ?? null];
}

/**
 * Detect the intent from the question text.
 */
function detectIntent(text, polarity, entity, entity_2) {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return intent;
    }
  }

  // Fallback heuristics
  if (entity_2) return 'relation_between_entities';
  if (polarity)  return 'neighbors_by_polarity';
  if (entity)    return 'character_summary';
  return 'top_central_characters';
}

/**
 * Rule-based intent parser — replaces the Gemini parseIntent call.
 * Zero API calls, instant, deterministic.
 */
function parseIntent(question, bookHint) {
  const book     = detectBook(question, bookHint);
  const language = detectLanguage(question);
  const polarity = detectPolarity(question);
  const chapter  = detectChapter(question);
  const [entity, entity_2] = extractEntities(question);
  const intent   = detectIntent(question, polarity, entity, entity_2);

  const result = { language, intent, entity, entity_2, polarity, book, chapter };
  console.log('[parseIntent] rule-based result:', JSON.stringify(result));
  return result;
}


// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Query engine (pure local data)
// ─────────────────────────────────────────────────────────────────────────────

function filterByBook(data, book) {
  if (!Array.isArray(data)) return [];
  if (!book || book === 'all') return data;
  return data.filter(r => r.book === book);
}

/**
 * Deduplicate nodes: nodes_flat.json has one entry per (book, chapter, id).
 * We only need one entry per (book, id) for matching purposes.
 * When book='all', we deduplicate globally by id.
 */
function deduplicateNodes(pool) {
  const seen = new Map();
  for (const n of pool) {
    if (!n || typeof n.id !== 'string') continue;
    const key = `${n.book}::${n.id}`;
    if (!seen.has(key)) seen.set(key, n);
  }
  return Array.from(seen.values());
}

/**
 * Safe lowercase: returns empty string for null/undefined/non-string values.
 */
function safeLower(val) {
  return typeof val === 'string' ? val.toLowerCase() : '';
}

/**
 * Find the canonical node id that best matches a character name.
 *
 * Priority order:
 *   1. Exact id match (case-insensitive)
 *   2. Exact alias match (case-insensitive)
 *   3. Partial match: id contains name, or name contains id (min 3 chars)
 *   4. Partial match: any alias contains name, or name contains alias (min 3 chars)
 *
 * Returns the canonical id string, or null if no match found.
 *
 * @param {string|null} name      - Character name from intent (may be null)
 * @param {Array}       nodesData - Full nodes_flat.json array
 * @param {string}      book      - 'lca' | 'paf' | 'all'
 * @returns {string|null}
 */
function findEntityId(name, nodesData, book) {
  if (!name || typeof name !== 'string') return null;
  if (!Array.isArray(nodesData) || nodesData.length === 0) {
    console.warn('[findEntityId] nodesData is empty or not an array');
    return null;
  }

  const pool  = deduplicateNodes(filterByBook(nodesData, book));
  const lname = name.toLowerCase().trim();

  if (!lname) return null;

  // 1. Exact id match
  for (const n of pool) {
    if (safeLower(n.id) === lname) {
      console.log(`[findEntityId] exact id match: "${name}" -> "${n.id}"`);
      return n.id;
    }
  }

  // 2. Exact alias match
  for (const n of pool) {
    for (const alias of (Array.isArray(n.aliases) ? n.aliases : [])) {
      if (safeLower(alias) === lname) {
        console.log(`[findEntityId] exact alias match: "${name}" -> "${n.id}" (alias: "${alias}")`);
        return n.id;
      }
    }
  }

  // 3. Partial id match (guard: both sides must be at least 3 chars to avoid noise)
  if (lname.length >= 3) {
    for (const n of pool) {
      const lid = safeLower(n.id);
      if (lid.length >= 3 && (lid.includes(lname) || lname.includes(lid))) {
        console.log(`[findEntityId] partial id match: "${name}" -> "${n.id}"`);
        return n.id;
      }
    }

    // 4. Partial alias match
    for (const n of pool) {
      for (const alias of (Array.isArray(n.aliases) ? n.aliases : [])) {
        const lalias = safeLower(alias);
        if (lalias.length >= 3 && (lalias.includes(lname) || lname.includes(lalias))) {
          console.log(`[findEntityId] partial alias match: "${name}" -> "${n.id}" (alias: "${alias}")`);
          return n.id;
        }
      }
    }
  }

  console.warn(`[findEntityId] no match found for: "${name}" in book="${book}"`);
  return null;
}

/**
 * Normalize chapter value to number or null.
 * Handles Gemini sometimes returning chapter as a string.
 */
function normalizeChapter(chapter) {
  if (chapter === null || chapter === undefined) return null;
  const n = Number(chapter);
  return isNaN(n) ? null : n;
}

/**
 * Serialize a result object to a plain JSON-safe object.
 * Replaces any Set with a sorted array and removes internal tracking fields.
 */
function serializeResult(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (v instanceof Set) {
      // Convert Set to sorted array — do not include raw Set in output
      out[k] = [...v].sort((a, b) => a - b);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function executeQuery(intent, edgesData, nodesData) {
  if (!intent || typeof intent !== 'object') return [];

  const {
    intent:   intName,
    entity,
    entity_2,
    polarity,
    book,
  } = intent;

  // chapter must be a number for strict equality checks against edge data
  const chapter = normalizeChapter(intent.chapter);

  switch (intName) {

    // ── neighbors_by_polarity ────────────────────────────────────────────────
    case 'neighbors_by_polarity': {
      const eid = findEntityId(entity, nodesData, book);
      if (!eid) {
        console.warn(`[neighbors_by_polarity] entity not found: "${entity}"`);
        return [];
      }

      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e => e.source === eid || e.target === eid);
      if (polarity && polarity !== 'any') {
        edges = edges.filter(e => e.polarity_label === polarity);
      }

      // Aggregate by (book, neighbor, polarity) across chapters
      const agg = {};
      for (const e of edges) {
        const neighbor = e.source === eid ? e.target : e.source;
        const key = `${e.book}::${neighbor}::${e.polarity_label}`;
        if (!agg[key]) {
          agg[key] = {
            book:           e.book,
            entity:         neighbor,
            polarity_label: e.polarity_label,
            weight:         0,
            chapter_set:    new Set(),  // internal only — not serialized
          };
        }
        agg[key].weight += e.weight;
        agg[key].chapter_set.add(e.chapter);
      }

      return Object.values(agg)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 20)
        .map(r => ({
          book:           r.book,
          entity:         r.entity,
          polarity_label: r.polarity_label,
          weight:         r.weight,
          chapters:       [...r.chapter_set].sort((a, b) => a - b).join(', '),
          // chapter_set is intentionally excluded
        }));
    }

    // ── relation_between_entities ────────────────────────────────────────────
    case 'relation_between_entities': {
      const eid1 = findEntityId(entity,   nodesData, book);
      const eid2 = findEntityId(entity_2, nodesData, book);

      if (!eid1) {
        console.warn(`[relation_between_entities] entity not found: "${entity}"`);
        return [];
      }
      if (!eid2) {
        console.warn(`[relation_between_entities] entity_2 not found: "${entity_2}"`);
        return [];
      }

      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e =>
        (e.source === eid1 && e.target === eid2) ||
        (e.source === eid2 && e.target === eid1)
      );

      return edges
        .sort((a, b) => a.chapter - b.chapter)
        .map(e => ({
          book:           e.book,
          chapter:        e.chapter,
          source:         e.source,
          target:         e.target,
          polarity_label: e.polarity_label,
          polarity_score: e.polarity_score,
          weight:         e.weight,
        }));
    }

    // ── top_central_characters ───────────────────────────────────────────────
    case 'top_central_characters': {
      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);

      if (edges.length === 0) return [];

      // degree[id] = cumulative weight; meta[id] = { book, chapter_set }
      const degree = {};
      const meta   = {};

      for (const e of edges) {
        for (const id of [e.source, e.target]) {
          if (typeof id !== 'string') continue;
          degree[id] = (degree[id] || 0) + e.weight;
          if (!meta[id]) meta[id] = { book: e.book, chapter_set: new Set() };
          meta[id].chapter_set.add(e.chapter);
        }
      }

      return Object.entries(degree)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([id, deg], i) => ({
          rank:          i + 1,
          book:          meta[id]?.book ?? 'unknown',
          entity:        id,
          degree:        deg,
          chapter_count: meta[id]?.chapter_set.size ?? 0,
          // chapter_set is intentionally excluded
        }));
    }

    // ── character_summary ────────────────────────────────────────────────────
    case 'character_summary': {
      const eid = findEntityId(entity, nodesData, book);
      if (!eid) {
        console.warn(`[character_summary] entity not found: "${entity}"`);
        return [];
      }

      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e => e.source === eid || e.target === eid);

      if (edges.length === 0) return [];

      // agg[key] = { book, entity, ami, neutre, ennemi, weight, chapter_set }
      const agg = {};
      for (const e of edges) {
        const neighbor = e.source === eid ? e.target : e.source;
        const key = `${e.book}::${neighbor}`;
        if (!agg[key]) {
          agg[key] = {
            book:        e.book,
            entity:      neighbor,
            ami:         0,
            neutre:      0,
            ennemi:      0,
            weight:      0,
            chapter_set: new Set(),
          };
        }
        const polKey = e.polarity_label;
        if (polKey in agg[key]) agg[key][polKey] += 1;
        agg[key].weight      += e.weight;
        agg[key].chapter_set.add(e.chapter);
      }

      return Object.values(agg)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 15)
        .map(r => ({
          book:           r.book,
          entity:         r.entity,
          polarity_label: r.ami > r.ennemi ? 'ami' : r.ennemi > r.ami ? 'ennemi' : 'neutre',
          ami:            r.ami,
          neutre:         r.neutre,
          ennemi:         r.ennemi,
          weight:         r.weight,
          chapters:       [...r.chapter_set].sort((a, b) => a - b).join(', '),
          // chapter_set is intentionally excluded
        }));
    }

    // ── book_or_chapter_stats ────────────────────────────────────────────────
    case 'book_or_chapter_stats': {
      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);

      if (edges.length === 0) return [];

      const books = [...new Set(edges.map(e => e.book))];
      return books.map(b => {
        const be  = edges.filter(e => e.book === b);
        const ids = new Set([...be.map(e => e.source), ...be.map(e => e.target)]);
        const pol = { ami: 0, neutre: 0, ennemi: 0 };
        for (const e of be) {
          if (e.polarity_label in pol) pol[e.polarity_label] += 1;
        }
        return {
          book:           b,
          node_count:     ids.size,
          edge_count:     be.length,
          total_weight:   be.reduce((s, e) => s + e.weight, 0),
          pol_ami:        pol.ami,
          pol_neutre:     pol.neutre,
          pol_ennemi:     pol.ennemi,
        };
      });
    }

    default:
      console.warn(`[executeQuery] unknown intent: "${intName}"`);
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Natural-language answer generation
// ─────────────────────────────────────────────────────────────────────────────

function buildAnswerPrompt(question, intent, results) {
  const lang = intent.language === 'en' ? 'English' : 'French';

  return `Tu es un assistant academique analysant des reseaux de personnages du Cycle de Fondation d'Isaac Asimov.
Tu dois rediger une reponse concise et precise en ${lang === 'English' ? 'English' : 'francais'}.

Question originale : "${question}"

Intention detectee : ${intent.intent}
Entite : ${intent.entity || 'N/A'}
Entite 2 : ${intent.entity_2 || 'N/A'}
Polarite filtree : ${intent.polarity || 'toutes'}
Corpus : ${intent.book || 'all'}

Donnees extraites du graphe (${results.length} resultats) :
${JSON.stringify(results.slice(0, 25), null, 2)}

Instructions :
- Redige une reponse naturelle et structuree en ${lang === 'English' ? 'English' : 'francais'}.
- Base-toi UNIQUEMENT sur les donnees ci-dessus, pas sur ta memoire.
- Si les donnees sont vides, dis-le clairement.
- Utilise **bold** pour mettre en valeur les noms de personnages.
- Sois synthetique : 2-5 phrases maximum pour l'analyse narrative.
- Ne recite pas le JSON brut.
- Mentionne les polarites (ami / ennemi / neutre) de facon naturelle.`;
}

async function generateAnswer(apiKey, question, intent, results) {
  if (!results || results.length === 0) {
    return intent.language === 'en'
      ? 'No data found for this query in the graph. The character may not appear in the selected corpus, or no edges match the specified filters.'
      : "Aucune donnee trouvee pour cette requete dans le graphe. Le personnage n'apparait peut-etre pas dans le corpus selectionne, ou aucun lien ne correspond aux filtres specifies.";
  }

  const prompt = buildAnswerPrompt(question, intent, results);
  return await callGemini(apiKey, prompt, 512);
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API helper — with retry on 429 and in-memory response cache
// ─────────────────────────────────────────────────────────────────────────────

// Simple in-memory cache for the duration of the Worker instance lifetime.
// Keyed by a hash of (prompt, maxTokens). Avoids double-billing identical
// requests and protects against 429 on repeated test queries.
const GEMINI_CACHE = new Map();
const CACHE_MAX_SIZE = 64; // evict oldest entry when full

function cacheKey(prompt, maxTokens) {
  // Lightweight hash: first 120 chars + last 60 chars + maxTokens
  const sig = prompt.slice(0, 120) + '|' + prompt.slice(-60) + '|' + maxTokens;
  return sig;
}

/**
 * Call the Gemini API with automatic retry on 429 (rate limit).
 * Retries up to MAX_RETRIES times with exponential backoff.
 * Results are cached in memory for the lifetime of the Worker instance.
 */
async function callGemini(apiKey, prompt, maxTokens = 512) {
  const key = cacheKey(prompt, maxTokens);

  if (GEMINI_CACHE.has(key)) {
    console.log('[callGemini] cache hit');
    return GEMINI_CACHE.get(key);
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.2,
    },
  };

  const MAX_RETRIES = 3;
  // Backoff delays in ms: 2s, 6s, 15s
  const BACKOFF_MS = [2000, 6000, 15000];

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BACKOFF_MS[attempt - 1] ?? 15000;
      console.warn(`[callGemini] 429 rate limit — retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Rate limited — retry
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      if (retryAfter && attempt < MAX_RETRIES) {
        const waitMs = Math.min(parseInt(retryAfter, 10) * 1000 || BACKOFF_MS[attempt], 30000);
        console.warn(`[callGemini] Retry-After header: ${retryAfter}s — waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      lastError = new Error(
        'Quota Gemini API depasse (429). Le tier gratuit est limite a 15 requetes/minute. ' +
        'Patientez quelques secondes et reessayez, ou configurez la facturation sur ' +
        'https://aistudio.google.com/apikey'
      );
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Reponse Gemini vide ou bloquee par le filtre de securite.');

    const result = text.trim();

    // Store in cache — evict oldest entry if at capacity
    if (GEMINI_CACHE.size >= CACHE_MAX_SIZE) {
      const oldestKey = GEMINI_CACHE.keys().next().value;
      GEMINI_CACHE.delete(oldestKey);
    }
    GEMINI_CACHE.set(key, result);

    return result;
  }

  // All retries exhausted
  throw lastError ?? new Error('Gemini API : echec apres plusieurs tentatives.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  let resp;
  try {
    resp = await fetch(url);
  } catch (networkErr) {
    throw new Error(`Network error fetching ${url}: ${networkErr.message}`);
  }
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * Fetch a static asset, preferring the Cloudflare ASSETS binding when available.
 * The ASSETS binding (context.env.ASSETS) is the correct Cloudflare-native way
 * to read Pages static assets from a Pages Function without a network roundtrip.
 * Falls back to a plain HTTP fetch for local development.
 */
async function fetchAsset(context, url) {
  if (context.env && context.env.ASSETS) {
    let resp;
    try {
      resp = await context.env.ASSETS.fetch(new Request(url));
    } catch (err) {
      throw new Error(`ASSETS fetch failed for ${url}: ${err.message}`);
    }
    if (!resp.ok) {
      throw new Error(
        `Static asset not found via ASSETS binding: ${url} (HTTP ${resp.status}). ` +
        'Check that the data/ directory is included in your Pages deployment.'
      );
    }
    return resp.json();
  }

  // Local dev fallback — no ASSETS binding available
  return fetchJson(url);
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}