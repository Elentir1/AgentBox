// AgentBox plugin module implements the tenant document index.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const AGENTBOX_DB_RELATIVE_PATH = ["plugins", "agentbox", "agentbox-index.sqlite"] as const;
const AGENTBOX_SQLITE_BUSY_TIMEOUT_MS = 5000;
const AGENTBOX_SQLITE_DIR_MODE = 0o700;
const AGENTBOX_SQLITE_FILE_MODE = 0o600;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agentbox_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agentbox_documents (
  source_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_url TEXT,
  size_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agentbox_documents_source_id ON agentbox_documents (source_id);

CREATE TABLE IF NOT EXISTS agentbox_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  norm REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS agentbox_chunks_document_id ON agentbox_chunks (document_id);

CREATE TABLE IF NOT EXISTS agentbox_cursors (
  source_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL
);
`;

export type AgentBoxIndexedDocument = {
  sourceKey: string;
  sourceId: string;
  documentId: string;
  name: string;
  fingerprint: string;
  sourceUrl?: string;
  sizeBytes: number;
};

export type AgentBoxIndexedChunk = {
  text: string;
  embedding: number[];
};

export type AgentBoxIndexTotals = {
  documents: number;
  bytes: number;
};

export type AgentBoxIndexMatch = {
  content: string;
  documentId: string;
  documentName: string;
  sourceUrl?: string;
  similarity: number;
};

type DocumentRow = {
  source_key: string;
  source_id: string;
  document_id: string;
  name: string;
  fingerprint: string;
  source_url: string | null;
  size_bytes: number;
};

type ChunkRow = {
  text: string;
  embedding: Uint8Array;
  norm: number;
  document_id: string;
  name: string;
  source_url: string | null;
};

function toIndexedDocument(row: DocumentRow): AgentBoxIndexedDocument {
  const document: AgentBoxIndexedDocument = {
    sourceKey: row.source_key,
    sourceId: row.source_id,
    documentId: row.document_id,
    name: row.name,
    fingerprint: row.fingerprint,
    sizeBytes: row.size_bytes,
  };
  if (row.source_url) {
    document.sourceUrl = row.source_url;
  }
  return document;
}

export type AgentBoxIndexStore = {
  documentsForSource: (sourceId: string) => AgentBoxIndexedDocument[];
  totals: () => AgentBoxIndexTotals;
  putDocument: (document: AgentBoxIndexedDocument, chunks: AgentBoxIndexedChunk[]) => void;
  deleteDocument: (sourceKey: string) => void;
  cursorForSource: (sourceId: string) => string | undefined;
  putCursor: (sourceId: string, cursor: string) => void;
  search: (queryEmbedding: number[], limit: number, minSimilarity: number) => AgentBoxIndexMatch[];
  close: () => void;
};

export function resolveAgentBoxIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...AGENTBOX_DB_RELATIVE_PATH);
}

function vectorNorm(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value * value;
  }
  return Math.sqrt(total);
}

/**
 * Cosine similarity against a pre-normalized query. Chunk norms are stored at
 * write time so retrieval only pays for the dot product.
 */
function similarity(
  query: Float32Array,
  queryNorm: number,
  chunk: Float32Array,
  chunkNorm: number,
): number {
  if (queryNorm === 0 || chunkNorm === 0 || query.length !== chunk.length) {
    return 0;
  }
  let dot = 0;
  for (let index = 0; index < query.length; index += 1) {
    dot += (query[index] ?? 0) * (chunk[index] ?? 0);
  }
  return dot / (queryNorm * chunkNorm);
}

/**
 * Vectors are stored as raw float32 rather than JSON. Every query scans every
 * chunk, so parsing text embeddings dominated retrieval time and tripled the
 * index size.
 */
function encodeEmbedding(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

function decodeEmbedding(value: Uint8Array): Float32Array {
  return new Float32Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

/**
 * Opens the tenant's document index. The index is derived data: when the
 * embedding identity changes, old vectors cannot be compared against new ones,
 * so the corpus is dropped and re-indexed rather than silently mixed.
 */
export function openAgentBoxIndexStore(params: {
  embeddingIdentity: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AgentBoxIndexStore {
  const databasePath = params.databasePath ?? resolveAgentBoxIndexPath(params.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: AGENTBOX_SQLITE_DIR_MODE });
  const db = new DatabaseSync(databasePath);
  configureSqliteConnectionPragmas(db, { busyTimeoutMs: AGENTBOX_SQLITE_BUSY_TIMEOUT_MS });
  db.exec(SCHEMA);
  try {
    fs.chmodSync(databasePath, AGENTBOX_SQLITE_FILE_MODE);
  } catch {
    // A pre-existing file owned by another uid keeps its mode; the directory is still 0700.
  }

  const readMeta = db.prepare("SELECT value FROM agentbox_index_meta WHERE key = ?");
  const writeMeta = db.prepare(
    "INSERT INTO agentbox_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const storedIdentity = (readMeta.get("embedding_identity") as { value: string } | undefined)
    ?.value;
  if (storedIdentity !== params.embeddingIdentity) {
    db.exec(
      "DELETE FROM agentbox_chunks; DELETE FROM agentbox_documents; DELETE FROM agentbox_cursors;",
    );
    writeMeta.run("embedding_identity", params.embeddingIdentity);
  }

  const selectBySource = db.prepare(
    "SELECT source_key, source_id, document_id, name, fingerprint, source_url, size_bytes FROM agentbox_documents WHERE source_id = ?",
  );
  const selectTotals = db.prepare(
    "SELECT COUNT(*) AS documents, COALESCE(SUM(size_bytes), 0) AS bytes FROM agentbox_documents",
  );
  const selectDocumentId = db.prepare(
    "SELECT document_id FROM agentbox_documents WHERE source_key = ?",
  );
  const upsertDocument = db.prepare(
    `INSERT INTO agentbox_documents (source_key, source_id, document_id, name, fingerprint, source_url, size_bytes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       source_id = excluded.source_id,
       document_id = excluded.document_id,
       name = excluded.name,
       fingerprint = excluded.fingerprint,
       source_url = excluded.source_url,
       size_bytes = excluded.size_bytes,
       updated_at = excluded.updated_at`,
  );
  const deleteDocumentRow = db.prepare("DELETE FROM agentbox_documents WHERE source_key = ?");
  const deleteChunksFor = db.prepare("DELETE FROM agentbox_chunks WHERE document_id = ?");
  const insertChunk = db.prepare(
    "INSERT INTO agentbox_chunks (id, document_id, ordinal, text, embedding, norm) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectChunks = db.prepare(
    `SELECT c.text AS text, c.embedding AS embedding, c.norm AS norm,
            d.document_id AS document_id, d.name AS name, d.source_url AS source_url
     FROM agentbox_chunks c
     JOIN agentbox_documents d ON d.document_id = c.document_id`,
  );
  const selectCursor = db.prepare("SELECT cursor FROM agentbox_cursors WHERE source_id = ?");
  const upsertCursor = db.prepare(
    "INSERT INTO agentbox_cursors (source_id, cursor) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor",
  );

  return {
    documentsForSource(sourceId) {
      return (selectBySource.all(sourceId) as DocumentRow[]).map(toIndexedDocument);
    },
    totals() {
      const row = selectTotals.get() as { documents: number; bytes: number } | undefined;
      return { documents: row?.documents ?? 0, bytes: row?.bytes ?? 0 };
    },
    putDocument(document, chunks) {
      // Chunks and their document move together: a half-written document would
      // answer questions from text the corpus no longer claims to contain.
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = selectDocumentId.get(document.sourceKey) as
          | { document_id: string }
          | undefined;
        if (previous?.document_id) {
          deleteChunksFor.run(previous.document_id);
        }
        deleteChunksFor.run(document.documentId);
        upsertDocument.run(
          document.sourceKey,
          document.sourceId,
          document.documentId,
          document.name,
          document.fingerprint,
          document.sourceUrl ?? null,
          document.sizeBytes,
          Date.now(),
        );
        for (const [ordinal, chunk] of chunks.entries()) {
          insertChunk.run(
            `${document.documentId}:${ordinal}`,
            document.documentId,
            ordinal,
            chunk.text,
            encodeEmbedding(chunk.embedding),
            vectorNorm(chunk.embedding),
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    deleteDocument(sourceKey) {
      const existing = selectDocumentId.get(sourceKey) as { document_id: string } | undefined;
      if (!existing?.document_id) {
        return;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteChunksFor.run(existing.document_id);
        deleteDocumentRow.run(sourceKey);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    cursorForSource(sourceId) {
      const row = selectCursor.get(sourceId) as { cursor: string } | undefined;
      return row?.cursor;
    },
    putCursor(sourceId, cursor) {
      upsertCursor.run(sourceId, cursor);
    },
    search(queryEmbedding, limit, minSimilarity) {
      const queryNorm = vectorNorm(queryEmbedding);
      if (queryNorm === 0) {
        return [];
      }
      const query = Float32Array.from(queryEmbedding);
      const scored: AgentBoxIndexMatch[] = [];
      // Streaming keeps peak memory at one row: .all() would materialize every
      // chunk, document text included, on every query.
      for (const row of selectChunks.iterate() as Iterable<ChunkRow>) {
        const score = similarity(query, queryNorm, decodeEmbedding(row.embedding), row.norm);
        // Cosine ranks every chunk, including unrelated ones. Without a floor an
        // off-topic question would still cite a document, which is exactly the
        // invented-source failure the product forbids.
        if (score < minSimilarity) {
          continue;
        }
        const match: AgentBoxIndexMatch = {
          content: row.text,
          documentId: row.document_id,
          documentName: row.name,
          similarity: score,
        };
        if (row.source_url) {
          match.sourceUrl = row.source_url;
        }
        scored.push(match);
      }
      return scored
        .toSorted((left, right) => right.similarity - left.similarity)
        .slice(0, Math.max(1, limit));
    },
    close() {
      db.close();
    },
  };
}
