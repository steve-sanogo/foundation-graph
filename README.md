# Foundation Graph — Réseau de personnages Asimov

Visualisation interactive et interrogation en langage naturel des graphes de personnages du Cycle de Fondation d'Isaac Asimov.

**Deux modes :**
- **Explorer** — navigation visuelle par ouvrage et chapitre (graphe D3 force-directed)
- **Ask the Graph** — questions en langage naturel (fr / en) traitées par Gemini + données locales

---

## Arborescence

```
foundation-graph/
├── frontend/               ← Fichiers statiques servis par Cloudflare Pages
│   ├── index.html          ← Application principale (Explorer + Ask)
│   └── data/
│       ├── edges_flat.json ← Généré par prepare_data.py
│       └── nodes_flat.json ← Généré par prepare_data.py
├── functions/
│   └── api/
│       └── query.js        ← Cloudflare Pages Function (backend /api/query)
├── scripts/
│   └── prepare_data.py     ← Extraction des données plates depuis GraphML
├── wrangler.toml
└── README.md
```

---

## Prérequis

- Un compte [Cloudflare](https://dash.cloudflare.com) (gratuit)
- Une clé API [Google AI Studio](https://aistudio.google.com) (`gemini-1.5-flash` — tier gratuit)
- Python 3.8+ (pour la préparation des données)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (optionnel, pour déploiement CLI)

---

## Étape 1 — Préparer les données

Les fichiers `edges_flat.json` et `nodes_flat.json` sont lus à la fois par le frontend (Explorer)
et par la function backend (Ask the Graph).

### Option A — À partir du `graph_viewer.html` existant

```bash
python3 scripts/prepare_data.py --html path/to/graph_viewer.html --out frontend/data
```

### Option B — À partir d'un répertoire de fichiers GraphML

```bash
# Structure attendue :
#   graphml/
#     lca/0.graphml, 1.graphml, ...
#     paf/0.graphml, 1.graphml, ...

python3 scripts/prepare_data.py --dir path/to/graphml/ --out frontend/data
```

Résultat attendu :
```
✓ 249 nodes → frontend/data/nodes_flat.json
✓ 360 edges → frontend/data/edges_flat.json
```

---

## Étape 2 — Déployer sur Cloudflare Pages

### Via l'interface web (recommandé)

1. Ouvrez [dash.cloudflare.com](https://dash.cloudflare.com) → **Pages** → **Create a project**
2. Connectez votre dépôt GitHub (ou uploadez directement le dossier `frontend/`)
3. Paramètres de build :
   - **Framework preset** : None
   - **Build command** : *(laisser vide)*
   - **Build output directory** : `frontend`
4. Uploadez également le dossier `functions/` à la racine du projet
5. Cliquez **Save and Deploy**

> **Important** : Le dossier `functions/` doit être à la racine du dépôt, pas dans `frontend/`.
> Cloudflare détecte automatiquement les Pages Functions.

### Via Wrangler CLI

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy frontend --project-name foundation-graph
```

---

## Étape 3 — Configurer la clé Gemini

Dans l'interface Cloudflare Pages :
1. Votre projet → **Settings** → **Environment variables**
2. Ajouter : `GEMINI_API_KEY` = votre clé Google AI Studio
3. Choisir **Production** (et **Preview** si vous voulez tester en preview)

> La clé n'est jamais exposée côté client. Elle est uniquement lue par la Pages Function server-side.

---

## Mettre à jour les données (nouveau pipeline)

Après un nouveau run de votre pipeline NLP :

```bash
# Régénérer les fichiers plats
python3 scripts/prepare_data.py --html graph_viewer.html --out frontend/data

# Redéployer (les fichiers JSON seront servis comme assets statiques)
wrangler pages deploy frontend --project-name foundation-graph
```

---

## Développement local

```bash
# Installer Wrangler
npm install -g wrangler

# Lancer en local (simule Pages Functions + assets statiques)
wrangler pages dev frontend --compatibility-date 2024-01-01

# Ajouter la variable d'env pour les tests locaux
wrangler pages dev frontend --binding GEMINI_API_KEY=your_key_here
```

L'app sera disponible sur `http://localhost:8788`.

---

## Intentions supportées

| Intent | Description | Exemple |
|--------|-------------|---------|
| `neighbors_by_polarity` | Voisins d'un personnage selon une polarité | *Ennemis de Hari Seldon dans PAF* |
| `relation_between_entities` | Relation entre deux personnages | *Lien entre Baley et Daneel* |
| `top_central_characters` | Personnages les plus connectés | *Qui sont les hubs du graphe LCA ?* |
| `character_summary` | Résumé des connexions d'un personnage | *Résume le réseau de Hummin* |
| `book_or_chapter_stats` | Statistiques globales | *Stats du chapitre 5 de PAF* |

---

## Limites connues et améliorations futures

### Limites V1
- La résolution d'entités (entity matching) est heuristique — les variantes très éloignées peuvent ne pas être reconnues
- Gemini Flash peut produire un intent JSON malformé sur des questions ambiguës (fallback basique inclus)
- Pas de pagination sur les résultats (limité à ~20 résultats affichés)
- Pas de cache sur les appels Gemini (chaque question = 2 appels API)

### Améliorations futures
- **Cache KV Cloudflare** pour les questions fréquentes
- **Embeddings** pour un entity matching plus robuste (via Gemini Embeddings API)
- **Visualisation croisée** : surligner dans le graphe Explorer les entités mentionnées dans une réponse Ask
- **Export CSV** des résultats structurés
- **Historique de conversation** multi-tour (actuellement chaque question est indépendante)
- **Recherche fulltext** sur les alias de personnages

---

## Coût estimé (tier gratuit)

| Service | Limite gratuite | Usage estimé |
|---------|----------------|--------------|
| Cloudflare Pages | 500 déploiements/mois, 100k req/jour | ✓ largement suffisant |
| Gemini 1.5 Flash | 15 req/min, 1M req/jour | ✓ largement suffisant pour usage académique |
