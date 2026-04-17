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

    // ── Step 1: Parse intent ────────────────────────────────────────────────
    const intent = await parseIntent(GEMINI_KEY, question, bookHint);
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
// STEP 1 — Intent parsing with Gemini
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_PROMPT = `Tu es un assistant NLP specialise dans l'analyse de graphes de personnages du Cycle de Fondation d'Isaac Asimov.

Corpus disponibles :
- "lca" = "Les Cavernes d'Acier" / "The Caves of Steel"
- "paf" = "Prelude a Fondation" / "Prelude to Foundation"

Intentions disponibles :
- neighbors_by_polarity  → lister les voisins d'un personnage selon une polarite (ami / ennemi / neutre / any)
- relation_between_entities → detailler la relation entre deux personnages
- top_central_characters → classer les personnages les plus connectes
- character_summary      → resumer les connexions d'un personnage
- book_or_chapter_stats  → statistiques d'un chapitre ou d'un ouvrage

Regles :
- Normalise les noms de personnages a leur forme canonique courte (ex: "Hari Seldon", "Baley", "Daneel", "Hummin", "Dors").
- Pour "book" : utilise "lca", "paf", ou "all" si non precise ou ambigu.
- Pour "polarity" : utilise "ami", "ennemi", "neutre", ou null si non precise.
- Pour "chapter" : utilise un entier (ex: 3) si precise, sinon null. Ne mets jamais une chaine de caracteres.
- "language" : "fr" ou "en" selon la langue de la question.

Reponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans explications.

Format exact :
{
  "language": "fr",
  "intent": "neighbors_by_polarity",
  "entity": "Hari Seldon",
  "entity_2": null,
  "polarity": "ennemi",
  "book": "paf",
  "chapter": null
}

Question : `;

async function parseIntent(apiKey, question, bookHint) {
  const prompt = INTENT_PROMPT + question +
    (bookHint && bookHint !== 'all' ? `\n(L'utilisateur a filtre sur le corpus : ${bookHint})` : '');

  const raw = await callGemini(apiKey, prompt, 256);

  try {
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Enforce number type for chapter — Gemini sometimes returns a string
    if (parsed.chapter !== null && parsed.chapter !== undefined) {
      const n = Number(parsed.chapter);
      parsed.chapter = isNaN(n) ? null : n;
    }

    // Enforce bookHint if user forced a filter
    if (bookHint && bookHint !== 'all' && (!parsed.book || parsed.book === 'all')) {
      parsed.book = bookHint;
    }

    return parsed;

  } catch (parseErr) {
    console.warn('[parseIntent] Gemini returned non-parseable JSON, using fallback. Raw:', raw.slice(0, 200));
    return {
      language: 'fr',
      intent:   'character_summary',
      entity:   null,
      entity_2: null,
      polarity: null,
      book:     bookHint || 'all',
      chapter:  null,
    };
  }
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
// GEMINI API helper
// ─────────────────────────────────────────────────────────────────────────────

async function callGemini(apiKey, prompt, maxTokens = 512) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.2,
    },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');
  return text.trim();
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