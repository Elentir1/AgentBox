// AgentBox plugin test helpers provide a deterministic index and embedder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentBoxConfig } from "./config.js";
import { openAgentBoxIndexStore, type AgentBoxIndexStore } from "./index-store.js";
import type { AgentBoxEmbedder } from "./indexer.js";

/**
 * Bag-of-words vectors over a fixed vocabulary. Similarity is real cosine math on
 * a real SQLite index, so retrieval tests exercise storage and ranking rather
 * than a mocked search response.
 */
const TEST_VOCABULARY = [
  "leave",
  "vacation",
  "salary",
  "invoice",
  "policy",
  "contract",
  "holiday",
  "expense",
] as const;

export function embedForTests(text: string): number[] {
  const lower = text.toLowerCase();
  return TEST_VOCABULARY.map((word) => (lower.includes(word) ? 1 : 0));
}

export function createTestEmbedder(identity = "test://embeddings#v1"): AgentBoxEmbedder {
  return {
    identity,
    embedDocuments: async (texts) => texts.map(embedForTests),
    embedQuery: async (text) => embedForTests(text),
    close: async () => undefined,
  };
}

export function createTestIndexStore(params: {
  directories: string[];
  identity?: string;
}): AgentBoxIndexStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-index-"));
  params.directories.push(directory);
  return openAgentBoxIndexStore({
    embeddingIdentity: params.identity ?? "test://embeddings#v1",
    databasePath: path.join(directory, "agentbox-index.sqlite"),
  });
}

export function createTestAuditStore() {
  const events: Parameters<import("./state.js").AgentBoxAuditStore["append"]>[0][] = [];
  return {
    events,
    store: {
      append: async (event: (typeof events)[number]) => {
        events.push(event);
      },
      list: async (limit = 50) =>
        events.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, limit),
    },
  };
}

export function testEntitlements(
  overrides: Partial<AgentBoxConfig["entitlements"]> = {},
): AgentBoxConfig["entitlements"] {
  return {
    planId: "business",
    status: "active",
    quotas: {
      maxSources: 4,
      maxDocuments: 25_000,
      maxStorageBytes: 53_687_091_200,
      minSyncIntervalMinutes: 15,
    },
    ...overrides,
  };
}

export function testIndexConfig(): AgentBoxConfig["index"] {
  return {
    embedding: {
      baseUrl: "https://embeddings.example.test/v1",
      model: "test-embedding",
      apiKeyEnv: "AGENTBOX_EMBEDDING_API_KEY",
      allowPrivateNetwork: false,
    },
    chunk: { maxCharacters: 1500, overlapCharacters: 200 },
    minSimilarity: 0.15,
  };
}
