/**
 * functions/api/query.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare Pages Function — POST /api/query
 *
 * Pipeline:
 *   1. Parse intent locally  ← lib/intent_parser.js (zero API calls)
 *   2. Load flat JSON data from static assets
 *   3. Execute query locally against the data
 *   4. Generate a natural-language answer via Gemini
 *      Falls back to a local template if Gemini fails or key is absent.
 *
 * Environment variable (optional):
 *   GEMINI_API_KEY  — enables Gemini-based answer generation
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseIntentLocal } from '../lib/intent_parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body     = await request.json();
    const question = (body.question || '').trim();
    const bookHint = (body.book     || 'all').trim();

    console.log(`[query] question="${question}" bookHint="${bookHint}"`);

    if (!question) {
      return jsonResponse({ error: 'Empty question.' }, 400, corsHeaders);
    }

    // Step 1 — local rule-based parser (no API call)
    const intent = parseIntentLocal(question, bookHint);
    console.log('[query] intent:', JSON.stringify(intent));

    // Step 2 — load flat data
    const origin = new URL(request.url).origin;
    const [edgesData, nodesData] = await Promise.all([
      fetchAsset(context, `${origin}/data/edges_flat.json`),
      fetchAsset(context, `${origin}/data/nodes_flat.json`),
    ]);

    if (!Array.isArray(edgesData) || !Array.isArray(nodesData)) {
      throw new Error('Invalid data format: edges or nodes are not arrays.');
    }
    console.log(`[query] loaded ${edgesData.length} edges, ${nodesData.length} node entries`);

    // Step 3 — execute query
    const results = executeQuery(intent, edgesData, nodesData);
    console.log(`[query] ${results.length} results`);

    // Step 4 — generate answer (Gemini or local template)
    const answer = await generateAnswer(env.GEMINI_API_KEY || null, question, intent, results);

    return jsonResponse({ answer, intent, results }, 200, corsHeaders);

  } catch (err) {
    console.error('[query] unhandled error:', err.message, err.stack);
    return jsonResponse({ error: err.message || 'Internal error.' }, 500, corsHeaders);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Query engine (local data only)
// ─────────────────────────────────────────────────────────────────────────────

function filterByBook(data, book) {
  if (!Array.isArray(data)) return [];
  if (!book || book === 'all') return data;
  return data.filter(r => r.book === book);
}

/**
 * Deduplicate nodes: nodes_flat.json has one entry per (book, chapter, id).
 * For matching we only need one representative entry per (book, id).
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

function safeLower(val) {
  return typeof val === 'string' ? val.toLowerCase() : '';
}

/**
 * Resolve a raw entity name string to a canonical node id.
 * Priority: exact id > exact alias > partial id > partial alias.
 *
 * @param {string|null} name
 * @param {Array}       nodesData
 * @param {string}      book  'lca' | 'paf' | 'all'
 * @returns {string|null}
 */
function findEntityId(name, nodesData, book) {
  if (!name || typeof name !== 'string') return null;
  if (!Array.isArray(nodesData) || nodesData.length === 0) return null;

  const pool  = deduplicateNodes(filterByBook(nodesData, book));
  const lname = name.toLowerCase().trim();
  if (!lname) return null;

  // 1. Exact id
  for (const n of pool) {
    if (safeLower(n.id) === lname) return n.id;
  }
  // 2. Exact alias
  for (const n of pool) {
    for (const alias of (Array.isArray(n.aliases) ? n.aliases : [])) {
      if (safeLower(alias) === lname) return n.id;
    }
  }
  // 3 & 4. Partial (min 3 chars each side)
  if (lname.length >= 3) {
    for (const n of pool) {
      const lid = safeLower(n.id);
      if (lid.length >= 3 && (lid.includes(lname) || lname.includes(lid))) {
        console.log(`[findEntityId] partial id: "${name}" -> "${n.id}"`);
        return n.id;
      }
    }
    for (const n of pool) {
      for (const alias of (Array.isArray(n.aliases) ? n.aliases : [])) {
        const la = safeLower(alias);
        if (la.length >= 3 && (la.includes(lname) || lname.includes(la))) {
          console.log(`[findEntityId] partial alias: "${name}" -> "${n.id}" via "${alias}"`);
          return n.id;
        }
      }
    }
  }

  console.warn(`[findEntityId] no match: "${name}" book="${book}"`);
  return null;
}

function normalizeChapter(chapter) {
  if (chapter === null || chapter === undefined) return null;
  const n = Number(chapter);
  return isNaN(n) ? null : n;
}

function executeQuery(intent, edgesData, nodesData) {
  if (!intent || typeof intent !== 'object') return [];

  const { intent: intName, entity, entity_2, polarity, book } = intent;
  const chapter = normalizeChapter(intent.chapter);

  switch (intName) {

    // ── neighbors_by_polarity ────────────────────────────────────────────────
    case 'neighbors_by_polarity': {
      const eid = findEntityId(entity, nodesData, book);
      if (!eid) { console.warn(`[neighbors_by_polarity] unresolved: "${entity}"`); return []; }

      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e => e.source === eid || e.target === eid);
      if (polarity && polarity !== 'any') edges = edges.filter(e => e.polarity_label === polarity);

      const agg = {};
      for (const e of edges) {
        const neighbor = e.source === eid ? e.target : e.source;
        const key = `${e.book}::${neighbor}::${e.polarity_label}`;
        if (!agg[key]) {
          agg[key] = { book: e.book, entity: neighbor,
                       polarity_label: e.polarity_label, weight: 0, chapter_set: new Set() };
        }
        agg[key].weight += e.weight;
        agg[key].chapter_set.add(e.chapter);
      }
      return Object.values(agg)
        .sort((a, b) => b.weight - a.weight).slice(0, 20)
        .map(r => ({ book: r.book, entity: r.entity, polarity_label: r.polarity_label,
                     weight: r.weight,
                     chapters: [...r.chapter_set].sort((a, b) => a - b).join(', ') }));
    }

    // ── relation_between_entities ────────────────────────────────────────────
    case 'relation_between_entities': {
      const eid1 = findEntityId(entity,   nodesData, book);
      const eid2 = findEntityId(entity_2, nodesData, book);
      if (!eid1) { console.warn(`[relation] unresolved entity: "${entity}"`);   return []; }
      if (!eid2) { console.warn(`[relation] unresolved entity_2: "${entity_2}"`); return []; }

      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e =>
        (e.source === eid1 && e.target === eid2) || (e.source === eid2 && e.target === eid1)
      );
      return edges.sort((a, b) => a.chapter - b.chapter)
        .map(e => ({ book: e.book, chapter: e.chapter, source: e.source, target: e.target,
                     polarity_label: e.polarity_label, polarity_score: e.polarity_score,
                     weight: e.weight }));
    }

    // ── top_central_characters ───────────────────────────────────────────────
    case 'top_central_characters': {
      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      if (edges.length === 0) return [];

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
      return Object.entries(degree).sort(([, a], [, b]) => b - a).slice(0, 15)
        .map(([id, deg], i) => ({ rank: i + 1, book: meta[id]?.book ?? 'unknown',
                                   entity: id, degree: deg,
                                   chapter_count: meta[id]?.chapter_set.size ?? 0 }));
    }

    // ── character_summary ────────────────────────────────────────────────────
    case 'character_summary': {
      const eid = findEntityId(entity, nodesData, book);
      if (!eid) { console.warn(`[character_summary] unresolved: "${entity}"`); return []; }

      let edges = filterByBook(edgesData, book);
      if (chapter !== null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e => e.source === eid || e.target === eid);
      if (edges.length === 0) return [];

      const agg = {};
      for (const e of edges) {
        const neighbor = e.source === eid ? e.target : e.source;
        const key = `${e.book}::${neighbor}`;
        if (!agg[key]) {
          agg[key] = { book: e.book, entity: neighbor,
                       ami: 0, neutre: 0, ennemi: 0, weight: 0, chapter_set: new Set() };
        }
        if (e.polarity_label in agg[key]) agg[key][e.polarity_label]++;
        agg[key].weight += e.weight;
        agg[key].chapter_set.add(e.chapter);
      }
      return Object.values(agg).sort((a, b) => b.weight - a.weight).slice(0, 15)
        .map(r => ({
          book:           r.book,
          entity:         r.entity,
          polarity_label: r.ami > r.ennemi ? 'ami' : r.ennemi > r.ami ? 'ennemi' : 'neutre',
          ami:            r.ami,
          neutre:         r.neutre,
          ennemi:         r.ennemi,
          weight:         r.weight,
          chapters:       [...r.chapter_set].sort((a, b) => a - b).join(', '),
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
        for (const e of be) { if (e.polarity_label in pol) pol[e.polarity_label]++; }
        return { book: b, node_count: ids.size, edge_count: be.length,
                 total_weight: be.reduce((s, e) => s + e.weight, 0),
                 pol_ami: pol.ami, pol_neutre: pol.neutre, pol_ennemi: pol.ennemi };
      });
    }

    default:
      console.warn(`[executeQuery] unknown intent: "${intName}"`);
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Answer generation (Gemini + local template fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a natural-language answer.
 * Uses Gemini when available; falls back to a template in all error cases.
 * This function never throws.
 */
async function generateAnswer(apiKey, question, intent, results) {
  if (!results || results.length === 0) {
    return localFallbackAnswer(intent, 'no_results');
  }
  if (!apiKey) {
    console.log('[generateAnswer] no API key — using template');
    return localFallbackAnswer(intent, 'no_key', results);
  }
  try {
    return await callGemini(apiKey, buildAnswerPrompt(question, intent, results), 512);
  } catch (err) {
    console.warn('[generateAnswer] Gemini failed — template fallback. Reason:', err.message);
    return localFallbackAnswer(intent, 'gemini_error', results);
  }
}

function buildAnswerPrompt(question, intent, results) {
  const fr = intent.language !== 'en';
  return `Tu es un assistant academique analysant des reseaux de personnages du Cycle de Fondation.
Reponds en ${fr ? 'francais' : 'English'}.

Question : "${question}"
Intent : ${intent.intent} | Entity : ${intent.entity || 'N/A'} | Entity2 : ${intent.entity_2 || 'N/A'}
Polarity : ${intent.polarity || 'all'} | Book : ${intent.book || 'all'}

Graph data (${results.length} results) :
${JSON.stringify(results.slice(0, 25), null, 2)}

Write 2-5 natural sentences in ${fr ? 'French' : 'English'}.
Use **bold** for character names. Reference only the data above, not your memory.
Mention polarity (ami/ennemi/neutre) naturally. Do not reproduce raw JSON.`;
}

/**
 * Template-based answer — readable output with zero API calls.
 *
 * @param {object} intent
 * @param {string} reason   'no_results' | 'no_key' | 'gemini_error'
 * @param {Array}  [results]
 * @returns {string}
 */
function localFallbackAnswer(intent, reason, results = []) {
  const fr     = intent.language !== 'en';
  const entity = intent.entity || '?';

  if (reason === 'no_results') {
    return fr
      ? 'Aucun resultat trouve pour cette requete dans le graphe.'
      : 'No results found for this query in the graph.';
  }

  const count = results.length;

  switch (intent.intent) {

    case 'neighbors_by_polarity': {
      const label = intent.polarity || (fr ? 'tous types' : 'all types');
      const names = results.slice(0, 5).map(r => r.entity).join(', ');
      return fr
        ? `**${entity}** a ${count} relation(s) de type « ${label} ». Principaux : ${names}.`
        : `**${entity}** has ${count} relation(s) of type "${label}". Main ones: ${names}.`;
    }

    case 'relation_between_entities': {
      const e2   = intent.entity_2 || '?';
      const pols = [...new Set(results.map(r => r.polarity_label))].join(', ');
      return fr
        ? `${count} lien(s) entre **${entity}** et **${e2}**. Polarite(s) : ${pols}.`
        : `${count} edge(s) between **${entity}** and **${e2}**. Polarity: ${pols}.`;
    }

    case 'top_central_characters': {
      const top = results.slice(0, 5)
        .map((r, i) => `${i + 1}. **${r.entity}** (${r.degree})`).join(' · ');
      return fr
        ? `Personnages les plus connectes : ${top}.`
        : `Most connected characters: ${top}.`;
    }

    case 'character_summary': {
      const names = results.slice(0, 5).map(r => r.entity).join(', ');
      return fr
        ? `**${entity}** interagit avec ${count} personnage(s). Principaux : ${names}.`
        : `**${entity}** interacts with ${count} character(s). Main ones: ${names}.`;
    }

    case 'book_or_chapter_stats': {
      return results.map(r =>
        fr
          ? `${r.book.toUpperCase()} : ${r.node_count} personnages, ${r.edge_count} liens (ami: ${r.pol_ami}, neutre: ${r.pol_neutre}, ennemi: ${r.pol_ennemi})`
          : `${r.book.toUpperCase()}: ${r.node_count} characters, ${r.edge_count} edges (ally: ${r.pol_ami}, neutral: ${r.pol_neutre}, enemy: ${r.pol_ennemi})`
      ).join('\n');
    }

    default:
      return fr ? `${count} resultat(s) trouve(s).` : `${count} result(s) found.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API — retry on 429, in-memory cache
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_CACHE   = new Map();
const CACHE_MAX_SIZE = 64;

function cacheKey(prompt, maxTokens) {
  return `${prompt.slice(0, 120)}|${prompt.slice(-60)}|${maxTokens}`;
}

async function callGemini(apiKey, prompt, maxTokens = 512) {
  const key = cacheKey(prompt, maxTokens);
  if (GEMINI_CACHE.has(key)) {
    console.log('[callGemini] cache hit');
    return GEMINI_CACHE.get(key);
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents:         [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
  };

  const BACKOFF_MS = [3000, 10000];
  let lastError    = null;

  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 10000);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      const waitMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
        : (BACKOFF_MS[attempt] ?? 10000);
      lastError = new Error('Quota Gemini depasse (429). Reessayez dans quelques secondes.');
      if (attempt < 2) { await sleep(waitMs); continue; }
      break;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Reponse Gemini vide.');

    const result = text.trim();
    if (GEMINI_CACHE.size >= CACHE_MAX_SIZE) {
      GEMINI_CACHE.delete(GEMINI_CACHE.keys().next().value);
    }
    GEMINI_CACHE.set(key, result);
    return result;
  }

  throw lastError ?? new Error('Gemini: echec apres plusieurs tentatives.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSET FETCHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a static asset via the ASSETS binding (Cloudflare production)
 * or a plain HTTP fetch (local dev with wrangler pages dev).
 */
async function fetchAsset(context, url) {
  if (context.env?.ASSETS) {
    let resp;
    try {
      resp = await context.env.ASSETS.fetch(new Request(url));
    } catch (err) {
      throw new Error(`ASSETS fetch failed for ${url}: ${err.message}`);
    }
    if (!resp.ok) {
      throw new Error(
        `Static asset not found: ${url} (HTTP ${resp.status}). ` +
        'Verify that data/ is included in your Pages deployment.'
      );
    }
    return resp.json();
  }
  return fetchJson(url);
}

async function fetchJson(url) {
  let resp;
  try { resp = await fetch(url); }
  catch (err) { throw new Error(`Network error fetching ${url}: ${err.message}`); }
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  return resp.json();
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
