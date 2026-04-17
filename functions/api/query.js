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

  // ── CORS preflight (if needed for local dev)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body     = await request.json();
    const question = (body.question || '').trim();
    const bookHint = (body.book || 'all').trim(); // 'lca' | 'paf' | 'all'

    if (!question) {
      return jsonResponse({ error: 'Empty question.' }, 400, corsHeaders);
    }

    const GEMINI_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_KEY) {
      return jsonResponse({ error: 'GEMINI_API_KEY not configured.' }, 500, corsHeaders);
    }

    // ── Step 1: Parse intent ────────────────────────────────────────────────
    const intent = await parseIntent(GEMINI_KEY, question, bookHint);

    // ── Step 2: Load flat data ───────────────────────────────────────────────
    const origin   = new URL(request.url).origin;
    const [edgesData, nodesData] = await Promise.all([
      fetchJson(`${origin}/data/edges_flat.json`),
      fetchJson(`${origin}/data/nodes_flat.json`),
    ]);

    // ── Step 3: Execute query ───────────────────────────────────────────────
    const results = executeQuery(intent, edgesData, nodesData);

    // ── Step 4: Generate answer ─────────────────────────────────────────────
    const answer = await generateAnswer(GEMINI_KEY, question, intent, results);

    return jsonResponse({ answer, intent, results }, 200, corsHeaders);

  } catch (err) {
    console.error('Query error:', err);
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

const INTENT_PROMPT = `Tu es un assistant NLP spécialisé dans l'analyse de graphes de personnages du Cycle de Fondation d'Isaac Asimov.

Corpus disponibles :
- "lca" = "Les Cavernes d'Acier" / "The Caves of Steel"
- "paf" = "Prélude à Fondation" / "Prelude to Foundation"

Intentions disponibles :
- neighbors_by_polarity  → lister les voisins d'un personnage selon une polarité (ami / ennemi / neutre / any)
- relation_between_entities → détailler la relation entre deux personnages
- top_central_characters → classer les personnages les plus connectés
- character_summary      → résumer les connexions d'un personnage
- book_or_chapter_stats  → statistiques d'un chapitre ou d'un ouvrage

Règles :
- Normalise les noms de personnages à leur forme canonique courte (ex: "Hari Seldon", "Baley", "Daneel", "Hummin", "Dors").
- Pour "book" : utilise "lca", "paf", ou "all" si non précisé ou ambigu.
- Pour "polarity" : utilise "ami", "ennemi", "neutre", ou null si non précisé.
- Pour "chapter" : utilise le numéro entier si précisé, sinon null.
- "language" : "fr" ou "en" selon la langue de la question.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans explications.

Format :
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
    (bookHint && bookHint !== 'all' ? `\n(L'utilisateur a filtré sur le corpus : ${bookHint})` : '');

  const raw = await callGemini(apiKey, prompt, 256);
  try {
    // Strip potential markdown fences
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    // Merge bookHint if user forced a filter
    if (bookHint && bookHint !== 'all' && parsed.book === 'all') {
      parsed.book = bookHint;
    }
    return parsed;
  } catch {
    // Fallback intent
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
  if (!book || book === 'all') return data;
  return data.filter(r => r.book === book);
}

/**
 * Fuzzy entity matcher — finds the canonical node id that best matches a name.
 * Checks exact match first, then case-insensitive partial match against aliases.
 */
function findEntityId(name, nodesData, book) {
  if (!name) return null;
  const pool = filterByBook(nodesData, book);
  const lname = name.toLowerCase();

  // Exact node id match
  const exact = pool.find(n => n.id.toLowerCase() === lname);
  if (exact) return exact.id;

  // Match against aliases
  for (const n of pool) {
    for (const alias of (n.aliases || [])) {
      if (alias.toLowerCase() === lname) return n.id;
    }
  }

  // Partial match (contains)
  for (const n of pool) {
    if (n.id.toLowerCase().includes(lname) || lname.includes(n.id.toLowerCase())) return n.id;
    for (const alias of (n.aliases || [])) {
      if (alias.toLowerCase().includes(lname) || lname.includes(alias.toLowerCase())) return n.id;
    }
  }

  return null;
}

function executeQuery(intent, edgesData, nodesData) {
  const { intent: intName, entity, entity_2, polarity, book, chapter } = intent;

  switch (intName) {

    case 'neighbors_by_polarity': {
      const eid = findEntityId(entity, nodesData, book);
      if (!eid) return [];

      let edges = filterByBook(edgesData, book);
      if (chapter != null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e => e.source === eid || e.target === eid);
      if (polarity && polarity !== 'any') edges = edges.filter(e => e.polarity_label === polarity);

      // Aggregate by neighbor + polarity across chapters
      const agg = {};
      edges.forEach(e => {
        const neighbor = e.source === eid ? e.target : e.source;
        const key = `${e.book}::${neighbor}::${e.polarity_label}`;
        if (!agg[key]) {
          agg[key] = {
            book: e.book,
            entity: neighbor,
            polarity_label: e.polarity_label,
            weight: 0,
            chapters: new Set(),
          };
        }
        agg[key].weight += e.weight;
        agg[key].chapters.add(e.chapter);
      });

      return Object.values(agg)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 20)
        .map(r => ({ ...r, chapter: [...r.chapters].sort((a,b)=>a-b).join(', ') }));
    }

    case 'relation_between_entities': {
      const eid1 = findEntityId(entity,   nodesData, book);
      const eid2 = findEntityId(entity_2, nodesData, book);
      if (!eid1 || !eid2) return [];

      let edges = filterByBook(edgesData, book);
      if (chapter != null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e =>
        (e.source === eid1 && e.target === eid2) ||
        (e.source === eid2 && e.target === eid1)
      );

      return edges
        .sort((a, b) => a.chapter - b.chapter)
        .map(e => ({
          book:          e.book,
          chapter:       e.chapter,
          source:        e.source,
          target:        e.target,
          polarity_label: e.polarity_label,
          polarity_score: e.polarity_score,
          weight:        e.weight,
        }));
    }

    case 'top_central_characters': {
      let edges = filterByBook(edgesData, book);
      if (chapter != null) edges = edges.filter(e => e.chapter === chapter);

      const degree = {};
      const chapters = {};
      edges.forEach(e => {
        [e.source, e.target].forEach(id => {
          degree[id]   = (degree[id] || 0) + e.weight;
          if (!chapters[id]) chapters[id] = { book: e.book, ids: new Set() };
          chapters[id].ids.add(e.chapter);
        });
      });

      return Object.entries(degree)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([id, deg], i) => ({
          rank:          i + 1,
          book:          chapters[id]?.book,
          entity:        id,
          degree:        deg,
          chapter_count: chapters[id]?.ids.size || 0,
        }));
    }

    case 'character_summary': {
      const eid = findEntityId(entity, nodesData, book);
      if (!eid) return [];

      let edges = filterByBook(edgesData, book);
      if (chapter != null) edges = edges.filter(e => e.chapter === chapter);
      edges = edges.filter(e => e.source === eid || e.target === eid);

      const agg = {};
      edges.forEach(e => {
        const neighbor = e.source === eid ? e.target : e.source;
        const key = `${e.book}::${neighbor}`;
        if (!agg[key]) {
          agg[key] = { book: e.book, entity: neighbor, ami: 0, neutre: 0, ennemi: 0, weight: 0, chapters: new Set() };
        }
        agg[key][e.polarity_label] = (agg[key][e.polarity_label] || 0) + 1;
        agg[key].weight += e.weight;
        agg[key].chapters.add(e.chapter);
      });

      return Object.values(agg)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 15)
        .map(r => ({
          ...r,
          polarity_label: r.ami > r.ennemi ? 'ami' : r.ennemi > r.ami ? 'ennemi' : 'neutre',
          chapter: [...r.chapters].sort((a,b)=>a-b).join(', '),
        }));
    }

    case 'book_or_chapter_stats': {
      let edges = filterByBook(edgesData, book);
      if (chapter != null) edges = edges.filter(e => e.chapter === chapter);

      const books = [...new Set(edges.map(e => e.book))];
      return books.map(b => {
        const be = edges.filter(e => e.book === b);
        const nodes = new Set([...be.map(e => e.source), ...be.map(e => e.target)]);
        const pol = { ami: 0, neutre: 0, ennemi: 0 };
        be.forEach(e => { pol[e.polarity_label] = (pol[e.polarity_label] || 0) + 1; });
        return {
          book:           b,
          entity:         `${nodes.size} personnages`,
          polarity_label: 'neutre',
          weight:         be.reduce((s, e) => s + e.weight, 0),
          chapter:        `${be.length} liens — ami: ${pol.ami} · neutre: ${pol.neutre} · ennemi: ${pol.ennemi}`,
        };
      });
    }

    default:
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Natural-language answer generation
// ─────────────────────────────────────────────────────────────────────────────

function buildAnswerPrompt(question, intent, results) {
  const lang = intent.language === 'en' ? 'English' : 'French';

  return `Tu es un assistant académique analysant des réseaux de personnages du Cycle de Fondation d'Isaac Asimov.
Tu dois rédiger une réponse concise et précise en ${lang === 'English' ? 'English' : 'français'}.

Question originale : "${question}"

Intention détectée : ${intent.intent}
Entité : ${intent.entity || 'N/A'}
Entité 2 : ${intent.entity_2 || 'N/A'}
Polarité filtrée : ${intent.polarity || 'toutes'}
Corpus : ${intent.book || 'all'}

Données extraites du graphe (${results.length} résultats) :
${JSON.stringify(results.slice(0, 25), null, 2)}

Instructions :
- Rédige une réponse naturelle et structurée en ${lang === 'English' ? 'English' : 'français'}.
- Base-toi UNIQUEMENT sur les données ci-dessus, pas sur ta mémoire.
- Si les données sont vides, dis-le clairement.
- Utilise **bold** pour mettre en valeur les noms de personnages.
- Sois synthétique : 2-5 phrases maximum pour l'analyse narrative.
- Ne récite pas le JSON brut.
- Mentionne les polarités (ami / ennemi / neutre) de façon naturelle.`;
}

async function generateAnswer(apiKey, question, intent, results) {
  if (!results || results.length === 0) {
    return intent.language === 'en'
      ? 'No data found for this query in the graph. The character may not appear in the selected corpus, or no edges match the specified filters.'
      : "Aucune donnée trouvée pour cette requête dans le graphe. Le personnage n'apparaît peut-être pas dans le corpus sélectionné, ou aucun lien ne correspond aux filtres spécifiés.";
  }

  const prompt = buildAnswerPrompt(question, intent, results);
  return await callGemini(apiKey, prompt, 512);
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API helper
// ─────────────────────────────────────────────────────────────────────────────

async function callGemini(apiKey, prompt, maxTokens = 512) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.json();
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
