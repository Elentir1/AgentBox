import { describe, expect, it, vi } from "vitest";
import type { AgentBoxConfig } from "./config.js";
import { AgentBoxService } from "./service.js";
import type { AgentBoxAuditEvent, AgentBoxDocumentState, AgentBoxStateStore } from "./state.js";

function createStateStore(initial: AgentBoxDocumentState[] = []): AgentBoxStateStore {
  const documents = new Map(initial.map((entry) => [entry.sourceKey, entry]));
  const cursors = new Map<string, string>();
  const audit: AgentBoxAuditEvent[] = [];
  return {
    async documentsForSource(sourceId) {
      return [...documents.values()].filter((entry) => entry.sourceId === sourceId);
    },
    async authorizedDocumentIds() {
      return new Set([...documents.values()].map((entry) => entry.documentId));
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
    async appendAudit(event) {
      audit.push(event);
    },
    async listAudit(limit = 50) {
      return audit.slice(-limit).toReversed();
    },
  };
}

const localConfig: AgentBoxConfig = {
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

describe("AgentBox synchronization", () => {
  it("uploads changed files, skips unchanged files, and removes snapshot tombstones", async () => {
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
      localConfig,
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
    await expect(service.audit()).resolves.toEqual([
      expect.objectContaining({ action: "sync", tenantId: "acme", uploaded: 1, deleted: 1 }),
    ]);
  });

  it("drops retrieval chunks that this tenant did not index", async () => {
    const warn = vi.fn();
    const service = new AgentBoxService(
      localConfig,
      createStateStore([
        {
          kind: "document",
          sourceId: "local",
          sourceKey: "local:leave-policy.md",
          fingerprint: "policy",
          documentId: "doc-leave",
          name: "leave-policy.md",
        },
      ]),
      { info: vi.fn(), warn, error: vi.fn() },
      {
        client: {
          upload: vi.fn(async () => "unused"),
          delete: vi.fn(async () => undefined),
          search: vi.fn(async () => [
            {
              content: "Employees receive 25 days of paid leave.",
              documentId: "doc-leave",
              documentName: "leave-policy.md",
              similarity: 0.94,
            },
            {
              content: "Salary bands for another company.",
              documentId: "doc-foreign",
              documentName: "salary.xlsx",
              similarity: 0.99,
            },
          ]),
        },
      },
    );

    const results = await service.search("How many leave days?", 8, "employee@203.0.113.10");

    expect(results).toEqual([
      {
        content: "Employees receive 25 days of paid leave.",
        documentId: "doc-leave",
        documentName: "leave-policy.md",
        similarity: 0.94,
      },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    const events = await service.audit();
    expect(events[0]).toMatchObject({
      action: "search",
      actor: "employee@203.0.113.10",
      tenantId: "acme",
      resultCount: 1,
      droppedCount: 1,
      documentIds: ["doc-leave"],
    });
    expect(events[0]?.queryPreview).toBe("How many leave days?");
    expect(events[0]?.queryDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
});
