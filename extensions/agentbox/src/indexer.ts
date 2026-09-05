// AgentBox plugin module implements document text extraction and embedding.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractDocumentContent } from "openclaw/plugin-sdk/document-extraction-runtime";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "openclaw/plugin-sdk/embedding-providers";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import type { AgentBoxConfig } from "./config.js";
import { requireConfiguredSecret } from "./config.js";

const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";
const EXTRACTION_MAX_PAGES = 500;
const EXTRACTION_MAX_PIXELS = 0;
const EXTRACTION_MIN_TEXT_CHARS = 1;
const EMBEDDING_BATCH_SIZE = 32;

const PLAIN_TEXT_MIME_PREFIXES = ["text/"] as const;
const PLAIN_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
]);

export type AgentBoxEmbedder = {
  identity: string;
  embedDocuments: (texts: string[]) => Promise<number[][]>;
  embedQuery: (text: string) => Promise<number[]>;
  close: () => Promise<void>;
};

function isPlainText(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    PLAIN_TEXT_MIME_TYPES.has(normalized) ||
    PLAIN_TEXT_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * Returns the document's text, or null when no registered extractor handles the
 * type. A null is a visible "unsupported format" state, not an empty document:
 * indexing an empty string would make the file look searchable when it is not.
 */
export async function extractDocumentText(params: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
  config?: OpenClawConfig;
}): Promise<string | null> {
  // Source adapters report a content type only when the provider sends one, so
  // the filename is the fallback. Without it every local file would look binary.
  const mimeType = params.mimeType?.trim() || mimeTypeFromFilePath(params.fileName) || "";
  if (isPlainText(mimeType)) {
    return new TextDecoder().decode(params.bytes);
  }
  const buffer = Buffer.from(params.bytes.buffer, params.bytes.byteOffset, params.bytes.byteLength);
  const extracted = await extractDocumentContent({
    buffer,
    mimeType,
    maxPages: EXTRACTION_MAX_PAGES,
    maxPixels: EXTRACTION_MAX_PIXELS,
    minTextChars: EXTRACTION_MIN_TEXT_CHARS,
    ...(params.config ? { config: params.config } : {}),
  });
  const text = extracted?.text?.trim();
  return text ? text : null;
}

/**
 * Splits on blank lines first so a chunk keeps whole paragraphs, then hard-splits
 * anything still over the limit. Consecutive chunks overlap so an answer spanning
 * a paragraph boundary stays retrievable.
 */
export function chunkDocumentText(
  text: string,
  options: { maxCharacters: number; overlapCharacters: number },
): string[] {
  const normalized = text.replace(/\r\n/gu, "\n").trim();
  if (!normalized) {
    return [];
  }
  const maxCharacters = Math.max(1, options.maxCharacters);
  const overlap = Math.min(Math.max(0, options.overlapCharacters), maxCharacters - 1);
  const paragraphs = normalized.split(/\n{2,}/u).flatMap((paragraph) => {
    const trimmed = paragraph.trim();
    if (trimmed.length <= maxCharacters) {
      return trimmed ? [trimmed] : [];
    }
    const pieces: string[] = [];
    for (let start = 0; start < trimmed.length; start += maxCharacters) {
      pieces.push(trimmed.slice(start, start + maxCharacters));
    }
    return pieces;
  });

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current =
      overlap > 0 && chunks.length > 0 ? tailOverlap(current, overlap, paragraph) : paragraph;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function tailOverlap(previous: string, overlap: number, next: string): string {
  const tail = previous.slice(-overlap).trimStart();
  return tail ? `${tail}\n\n${next}` : next;
}

/**
 * Builds the embedder from the tenant's configured OpenAI-compatible endpoint.
 * The identity string is persisted with the index: changing model or endpoint
 * invalidates every stored vector, so the corpus must be rebuilt rather than
 * compared across two embedding spaces.
 */
export async function createAgentBoxEmbedder(params: {
  config: AgentBoxConfig["index"]["embedding"];
  openClawConfig: OpenClawConfig;
}): Promise<AgentBoxEmbedder> {
  const adapter = getEmbeddingProvider(
    OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
    params.openClawConfig,
  );
  if (!adapter) {
    throw new Error(
      `AgentBox could not resolve the ${OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID} embedding provider.`,
    );
  }
  const apiKey = requireConfiguredSecret(params.config.apiKeyEnv);
  const created = await adapter.create({
    config: params.openClawConfig,
    model: params.config.model,
    remote: { baseUrl: params.config.baseUrl, apiKey },
    ...(typeof params.config.dimensions === "number"
      ? { dimensions: params.config.dimensions }
      : {}),
  });
  const provider: EmbeddingProvider | null = created.provider;
  if (!provider) {
    throw new Error(
      `AgentBox could not create an embedding provider for ${params.config.model} at ${params.config.baseUrl}.`,
    );
  }
  return {
    identity: `${params.config.baseUrl}#${params.config.model}`,
    async embedDocuments(texts) {
      const embeddings: number[][] = [];
      for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
        embeddings.push(...(await provider.embedBatch(batch, { inputType: "document" })));
      }
      return embeddings;
    },
    async embedQuery(text) {
      return await provider.embed(text, { inputType: "query" });
    },
    async close() {
      await provider.close?.();
    },
  };
}
