#!/usr/bin/env python3
"""
prepare_data.py
===============
Transforms GraphML graph data into flat JSON files for the Ask the Graph backend.

Two input modes:
  1. --html path/to/graph_viewer.html   → parse the embedded GRAPH_DATA JS object
  2. --dir  path/to/graphml/            → read directory with structure:
                                           graphml/lca/0.graphml, graphml/lca/1.graphml, ...
                                           graphml/paf/0.graphml, ...
Output (always):
  frontend/data/edges_flat.json
  frontend/data/nodes_flat.json
"""

import argparse
import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

NS = "http://graphml.graphdrawing.org/xmlns"


# ──────────────────────────────────────────────────────────────────────────────
# GraphML parsing
# ──────────────────────────────────────────────────────────────────────────────

def parse_graphml_string(xml_str: str, book: str, chapter: int):
    """Return (nodes_list, edges_list) from a raw GraphML string."""
    # Handle HTML entities that may be present
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        # Try with unicode replacement for HTML entities
        xml_str = xml_str.replace("&amp;", "&").replace("&#233;", "é").replace(
            "&#238;", "î").replace("&#8217;", "'").replace("&#226;", "â")
        # Re-escape & for XML
        xml_str = re.sub(r'&(?!amp;|lt;|gt;|quot;|apos;|#)', '&amp;', xml_str)
        try:
            root = ET.fromstring(xml_str)
        except ET.ParseError as e:
            print(f"  [WARN] Could not parse chapter {chapter} of {book}: {e}", file=sys.stderr)
            return [], []

    # Discover key → attribute mapping
    key_map = {}  # key_id → attr_name
    for key_el in root.iter(f"{{{NS}}}key"):
        kid = key_el.get("id")
        name = key_el.get("attr.name")
        if kid and name:
            key_map[kid] = name
    # Fallback for keyless files (d0=names, d1=weight, d2=polarity_score, d3=polarity_label)
    if not key_map:
        key_map = {"d0": "names", "d1": "weight", "d2": "polarity_score", "d3": "polarity_label"}

    graph_el = root.find(f".//{{{NS}}}graph")
    if graph_el is None:
        return [], []

    # Nodes
    node_aliases = {}   # node_id → [alias, ...]
    for node_el in graph_el.findall(f"{{{NS}}}node"):
        nid = node_el.get("id")
        aliases = [nid]
        for data_el in node_el.findall(f"{{{NS}}}data"):
            key = data_el.get("key")
            if key_map.get(key) in ("names", "label"):
                raw = (data_el.text or "").strip()
                aliases = [a.strip() for a in raw.split(";") if a.strip()]
                if nid not in aliases:
                    aliases.insert(0, nid)
        node_aliases[nid] = aliases

    nodes = []
    for nid, aliases in node_aliases.items():
        nodes.append({
            "book": book,
            "chapter": chapter,
            "id": nid,
            "label": aliases[0] if aliases else nid,
            "aliases": aliases,
        })

    # Edges
    edges = []
    for edge_el in graph_el.findall(f"{{{NS}}}edge"):
        src = edge_el.get("source")
        tgt = edge_el.get("target")
        rec = {
            "book": book,
            "chapter": chapter,
            "source": src,
            "target": tgt,
            "weight": 1,
            "polarity_label": "neutre",
            "polarity_score": 0.0,
            "source_aliases": node_aliases.get(src, [src]),
            "target_aliases": node_aliases.get(tgt, [tgt]),
        }
        for data_el in edge_el.findall(f"{{{NS}}}data"):
            attr = key_map.get(data_el.get("key"), "")
            val = (data_el.text or "").strip()
            if attr == "weight":
                try:
                    rec["weight"] = int(val)
                except ValueError:
                    pass
            elif attr == "polarity_score":
                try:
                    rec["polarity_score"] = float(val)
                except ValueError:
                    pass
            elif attr == "polarity_label":
                rec["polarity_label"] = val
        edges.append(rec)

    return nodes, edges


# ──────────────────────────────────────────────────────────────────────────────
# Input mode 1: parse from HTML
# ──────────────────────────────────────────────────────────────────────────────

def extract_from_html(html_path: Path):
    """Extract GRAPH_DATA from an HTML file containing the embedded JS object."""
    content = html_path.read_text(encoding="utf-8")

    # Find the GRAPH_DATA = {...} assignment
    match = re.search(r"const\s+GRAPH_DATA\s*=\s*(\{.*?\});\s*\n", content, re.DOTALL)
    if not match:
        sys.exit("Could not find GRAPH_DATA in the HTML file.")

    raw_js = match.group(1)

    # The JS object uses \" for inner quotes. Convert to valid JSON.
    # Strategy: the outer structure is { "lca": {...}, "paf": {...} }
    # Each chapter value is a GraphML XML string embedded as a JS string.
    # We use json.loads after minimal transforms.
    try:
        graph_data = json.loads(raw_js)
    except json.JSONDecodeError:
        # Try to fix common issues: unquoted keys
        # The GRAPH_DATA uses standard JSON-compatible syntax, so this usually works.
        sys.exit("Could not parse GRAPH_DATA as JSON. Check the HTML format.")

    all_nodes = []
    all_edges = []

    for book, chapters in graph_data.items():
        for chap_str, xml_str in chapters.items():
            chapter = int(chap_str)
            print(f"  Parsing {book} chapter {chapter}...")
            nodes, edges = parse_graphml_string(xml_str, book, chapter)
            all_nodes.extend(nodes)
            all_edges.extend(edges)

    return all_nodes, all_edges


# ──────────────────────────────────────────────────────────────────────────────
# Input mode 2: parse from directory of GraphML files
# ──────────────────────────────────────────────────────────────────────────────

def extract_from_dir(dir_path: Path):
    """Read all .graphml files from dir_path/{book}/{chapter}.graphml."""
    all_nodes = []
    all_edges = []

    for book_dir in sorted(dir_path.iterdir()):
        if not book_dir.is_dir():
            continue
        book = book_dir.name
        for gml_file in sorted(book_dir.glob("*.graphml"), key=lambda p: int(p.stem)):
            chapter = int(gml_file.stem)
            print(f"  Parsing {book} chapter {chapter}...")
            xml_str = gml_file.read_text(encoding="utf-8")
            nodes, edges = parse_graphml_string(xml_str, book, chapter)
            all_nodes.extend(nodes)
            all_edges.extend(edges)

    return all_nodes, all_edges


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Prepare flat JSON data from GraphML graphs.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--html", metavar="FILE", help="Path to graph_viewer.html with embedded GRAPH_DATA")
    group.add_argument("--dir",  metavar="DIR",  help="Path to directory of GraphML files (book/chapter.graphml)")
    parser.add_argument("--out", metavar="DIR", default="frontend/data",
                        help="Output directory (default: frontend/data)")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Extracting graph data...")
    if args.html:
        nodes, edges = extract_from_html(Path(args.html))
    else:
        nodes, edges = extract_from_dir(Path(args.dir))

    # Deduplicate nodes by (book, chapter, id)
    seen = set()
    unique_nodes = []
    for n in nodes:
        key = (n["book"], n["chapter"], n["id"])
        if key not in seen:
            seen.add(key)
            unique_nodes.append(n)

    edges_path = out_dir / "edges_flat.json"
    nodes_path = out_dir / "nodes_flat.json"

    edges_path.write_text(json.dumps(edges, ensure_ascii=False, indent=2), encoding="utf-8")
    nodes_path.write_text(json.dumps(unique_nodes, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n✓ {len(unique_nodes)} nodes → {nodes_path}")
    print(f"✓ {len(edges)} edges  → {edges_path}")
    print("\nBooks & chapters found:")
    from collections import defaultdict
    by_book = defaultdict(set)
    for e in edges:
        by_book[e["book"]].add(e["chapter"])
    for b, chaps in sorted(by_book.items()):
        print(f"  {b}: chapters {min(chaps)}–{max(chaps)} ({len(chaps)} chapters, {sum(1 for e in edges if e['book']==b)} edges)")


if __name__ == "__main__":
    main()
