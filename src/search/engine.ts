// Search engine: build an embedding corpus from a CodeGraph + source,
// run a semantic query against it via a pluggable EmbeddingAdapter,
// return top-K hits. Linear-scan vector store; fine for repos well
// under ~10k callable defines.

import type { CodeGraph, DefinesFact } from "../graph/types.js";
import type { EmbeddingAdapter } from "../llm/types.js";
import { VectorStore } from "./vector-store.js";
import { EmbeddingCache } from "./embedding-cache.js";

export interface SearchCorpusEntry {
  /** Stable id: `{file}#{name}#{line}` — deduplicates cross-class name clashes. */
  id: string;
  /** Short symbol name — function or method. */
  name: string;
  file: string;
  /** 1-based line number where the define begins. */
  line: number;
  /** Raw signature text, or the name when unavailable. */
  signature?: string;
  /** Leading JSDoc/docstring/block comment associated with the file. */
  leadingDoc?: string;
  /** Concatenated text used for embedding. */
  text: string;
}

export interface SearchHit {
  id: string;
  name: string;
  file: string;
  line: number;
  signature?: string;
  leadingDoc?: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

export interface RunSearchOptions {
  query: string;
  corpus: SearchCorpusEntry[];
  adapter: EmbeddingAdapter;
  topK: number;
  /** Optional cache to avoid re-embedding unchanged corpus entries. */
  cache?: EmbeddingCache;
}

/**
 * Turn a CodeGraph into an embedding-ready corpus. One entry per
 * callable define (function or method). Skips defines whose host file
 * isn't present in `files` (no text to extract a body snippet from).
 */
export function buildSearchCorpus(
  graph: CodeGraph,
  files: Map<string, string>,
): SearchCorpusEntry[] {
  const out: SearchCorpusEntry[] = [];
  // Index FileNode.fileDoc lookups (cheap; small map).
  const fileDoc = new Map<string, string>();
  for (const f of graph.files ?? []) {
    if (f.fileDoc) fileDoc.set(f.path, f.fileDoc);
  }
  for (const d of graph.defines) {
    if (d.kind !== "function" && d.kind !== "method") continue;
    const content = files.get(d.file);
    if (!content) continue;
    const snippet = snippetAround(content, d.line);
    const parts: string[] = [d.name];
    if (d.signature) parts.push(d.signature);
    const doc = fileDoc.get(d.file);
    if (doc) parts.push(doc);
    parts.push(snippet);
    const text = parts.join("\n").slice(0, 2000);
    out.push({
      id: makeEntryId(d),
      name: d.name,
      file: d.file,
      line: d.line,
      signature: d.signature,
      leadingDoc: doc,
      text,
    });
  }
  return out;
}

export async function runSearch(opts: RunSearchOptions): Promise<SearchHit[]> {
  const { query, corpus, adapter, topK, cache } = opts;
  if (corpus.length === 0) return [];

  // The dimension may be unknown until the first embed() — adapters that
  // learn it from the provider response (OpenAI-compatible, Azure) throw
  // from dimension() until then. Discover it lazily from cached or freshly
  // embedded vectors rather than requiring it up front, so the very first
  // search works without CHIASMUS_EMBED_DIM being set.
  let dim = tryDimension(adapter);

  const toEmbed: string[] = [];
  const toEmbedIdx: number[] = [];
  const cachedVecs = new Map<number, number[]>();

  for (let i = 0; i < corpus.length; i++) {
    const text = corpus[i].text;
    const hit = cache?.get(text) ?? null;
    // When dim is known, drop cache entries that don't match it (model
    // swap). When it isn't, trust the cache — it persists a single fixed
    // dimension — and adopt its vector length as the dimension.
    if (hit && (dim === null || hit.length === dim)) {
      if (dim === null) dim = hit.length;
      cachedVecs.set(i, hit);
    } else {
      toEmbed.push(text);
      toEmbedIdx.push(i);
    }
  }

  if (toEmbed.length > 0) {
    const fresh = await adapter.embed(toEmbed);
    for (let j = 0; j < fresh.length; j++) {
      const idx = toEmbedIdx[j];
      if (dim === null) dim = fresh[j].length;
      cachedVecs.set(idx, fresh[j]);
      cache?.put(toEmbed[j], fresh[j]);
    }
  }

  // Always need a query vector; this also pins the dimension when every
  // corpus entry was served from cache.
  const [queryVec] = await adapter.embed([query]);
  if (dim === null) dim = queryVec.length;

  const store = new VectorStore({ dimension: dim });
  for (let i = 0; i < corpus.length; i++) {
    const v = cachedVecs.get(i);
    if (!v) continue;
    store.add({ id: corpus[i].id, vector: v });
  }

  const hits = store.search(queryVec, topK);

  const byId = new Map<string, SearchCorpusEntry>();
  for (const e of corpus) byId.set(e.id, e);
  const out: SearchHit[] = [];
  for (const h of hits) {
    const e = byId.get(h.id);
    if (!e) continue;
    out.push({
      id: h.id,
      name: e.name,
      file: e.file,
      line: e.line,
      signature: e.signature,
      leadingDoc: e.leadingDoc,
      score: h.score,
    });
  }
  return out;
}

function makeEntryId(d: DefinesFact): string {
  return `${d.file}#${d.name}#${d.line}`;
}

/** adapter.dimension(), or null if it isn't known yet (throws before first embed). */
function tryDimension(adapter: EmbeddingAdapter): number | null {
  try {
    return adapter.dimension();
  } catch {
    return null;
  }
}

const SNIPPET_LINES = 6;

function snippetAround(source: string, startLine: number): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, start + SNIPPET_LINES);
  return lines.slice(start, end).join("\n");
}
