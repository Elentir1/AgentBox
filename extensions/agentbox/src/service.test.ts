import { describe, expect, it, vi } from "vitest";
import type { AgentBoxConfig } from "./config.js";
import { AgentBoxService } from "./service.js";
import type { AgentBoxDocumentState, AgentBoxStateStore } from "./state.js";

function createStateStore(initial: AgentBoxDocumentState[] = []): AgentBoxStateStore {
  const documents = new Map(initial.map((entry) => [entry.sourceKey, entry]));
  const cursors = new Map<string, string>();
  return {
    async documentsForSource(sourceId) {
      return [...documents.values()].filter((entry) => entry.sourceId === sourceId);
    },
    async cursorForSource(sourceId) {
      return cursors.get(sourceId);
    },
    async putDocument(entry) {
      documents.set(entry.sourceKey, entry);
    },
    async deleteDocument(sourceKey) {
      documents.delete(sourceKey);
    },
    async putCursor(sourceId, cursor) {
      cursors.set(sourceId, cursor);
    },
  };
}

describe("AgentBox synchronization", () => {
  it("uploads changed files, skips unchanged files, and removes snapshot tombstones", async () => {
    const config: AgentBoxConfig = {
      tenantId: "acme",
      backend: {
        baseUrl: "https://ragflow.example.test",
        datasetId: "acme",
        apiKeyEnv: "RAGFLOW_API_KEY",
        allowPrivateNetwork: false,
      },
      sync: { intervalMinutes: 15, maxFileBytes: 1024 },
      sources: [{ id: "local", type: "local", root: "/documents" }],
    };
    const state = createStateStore([
      {
        kind: "document",
        sourceId: "local",
        sourceKey: "local:unchanged.pdf",
        fingerprint: "same",
        documentId: "doc-unchanged",
        name: "unchanged.pdf",
      },
      {
        kind: "document",
        sourceId: "local",
        sourceKey: "local:removed.pdf",
        fingerprint: "old",
        documentId: "doc-removed",
        name: "removed.pdf",
      },
    ]);
    const upload = vi.fn(async () => "doc-new");
    const deleteDocuments = vi.fn(async () => undefined);
    const service = new AgentBoxService(
      config,
      state,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload,
          delete: deleteDocuments,
          search: vi.fn(async () => []),
        },
        createAdapter: () => ({
          id: "local",
          scan: async () => ({
            mode: "snapshot",
            deletedKeys: [],
            documents: [
              {
                key: "local:unchanged.pdf",
                name: "unchanged.pdf",
                modifiedAtMs: 1,
                size: 4,
                fingerprint: "same",
                read: async () => new Uint8Array([1]),
              },
              {
                key: "local:new.pdf",
                name: "new.pdf",
                modifiedAtMs: 2,
                size: 4,
                fingerprint: "new",
                read: async () => new Uint8Array([1, 2]),
              },
            ],
          }),
        }),
      },
    );

    const status = await service.runOnce();

    expect(upload).toHaveBeenCalledOnce();
    expect(deleteDocuments).toHaveBeenCalledWith(["doc-removed"]);
    expect(status.sources[0]).toMatchObject({
      state: "ready",
      indexed: 2,
      uploaded: 1,
      deleted: 1,
      skipped: 1,
    });
  });
});
