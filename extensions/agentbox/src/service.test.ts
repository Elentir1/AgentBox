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
    async indexTotals() {
      const sized = [...documents.values()].filter((entry) => typeof entry.sizeBytes === "number");
      return {
        documents: documents.size,
        measuredDocuments: sized.length,
        bytes: sized.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
      };
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
  entitlements: {
    planId: "business",
    status: "active",
    quotas: {
      maxSources: 4,
      maxDocuments: 25_000,
      maxStorageBytes: 53_687_091_200,
      minSyncIntervalMinutes: 15,
    },
  },
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

  it("stops a source at the document quota without deleting what is indexed", async () => {
    const state = createStateStore([
      {
        kind: "document",
        sourceId: "local",
        sourceKey: "local:kept.pdf",
        fingerprint: "kept",
        documentId: "doc-kept",
        name: "kept.pdf",
        sizeBytes: 64,
      },
    ]);
    const remove = vi.fn(async () => undefined);
    const service = new AgentBoxService(
      {
        ...localConfig,
        entitlements: {
          ...localConfig.entitlements,
          quotas: { ...localConfig.entitlements.quotas, maxDocuments: 1 },
        },
      },
      state,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload: vi.fn(async () => "doc-new"),
          delete: remove,
          search: vi.fn(async () => []),
        },
        createAdapter: (source) => ({
          id: source.id,
          async scan() {
            return {
              mode: "delta" as const,
              documents: [
                {
                  key: "local:new.pdf",
                  name: "new.pdf",
                  mimeType: "application/pdf",
                  fingerprint: "new",
                  size: 32,
                  modifiedAtMs: 1,
                  read: async () => Buffer.from("x".repeat(32)),
                },
              ],
              deletedKeys: [],
            };
          },
        }),
      },
    );

    const status = await service.runOnce();

    expect(status.sources[0]).toMatchObject({
      state: "error",
      error: expect.stringContaining("1 indexed documents"),
    });
    expect(status.sources[0]?.uploaded).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect(await state.authorizedDocumentIds()).toEqual(new Set(["doc-kept"]));
    expect(status.subscription.usage).toEqual({
      documents: 1,
      storage: { kind: "measured", bytes: 64 },
    });
  });

  it("refuses to scan or search while the subscription is suspended", async () => {
    const search = vi.fn(async () => []);
    const scan = vi.fn();
    const service = new AgentBoxService(
      {
        ...localConfig,
        entitlements: { ...localConfig.entitlements, status: "suspended" },
      },
      createStateStore(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload: vi.fn(async () => "unused"),
          delete: vi.fn(async () => undefined),
          search,
        },
        createAdapter: (source) => ({ id: source.id, scan: scan as never }),
      },
    );

    const status = await service.runOnce();

    expect(scan).not.toHaveBeenCalled();
    expect(status.subscription.state).toBe("suspended");
    await expect(service.search("anything")).rejects.toThrow("suspended");
    expect(search).not.toHaveBeenCalled();
  });

  it("reports storage as partial while documents predate size accounting", async () => {
    const service = new AgentBoxService(
      localConfig,
      createStateStore([
        {
          kind: "document",
          sourceId: "local",
          sourceKey: "local:legacy.pdf",
          fingerprint: "legacy",
          documentId: "doc-legacy",
          name: "legacy.pdf",
        },
        {
          kind: "document",
          sourceId: "local",
          sourceKey: "local:sized.pdf",
          fingerprint: "sized",
          documentId: "doc-sized",
          name: "sized.pdf",
          sizeBytes: 128,
        },
      ]),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload: vi.fn(async () => "unused"),
          delete: vi.fn(async () => undefined),
          search: vi.fn(async () => []),
        },
      },
    );

    const status = await service.refreshStatus();

    expect(status.subscription.usage).toEqual({
      documents: 2,
      storage: { kind: "partial", bytes: 128, unmeasuredDocuments: 1 },
    });
  });

  it("fails closed when RAGFlow is unreachable", async () => {
    const service = new AgentBoxService(
      localConfig,
      createStateStore(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload: vi.fn(async () => "unused"),
          delete: vi.fn(async () => undefined),
          search: vi.fn(async () => []),
          inspect: vi.fn(async () => {
            throw new Error("ECONNREFUSED");
          }),
        },
      },
    );

    const status = await service.runOnce();

    expect(status.backend).toMatchObject({
      state: "error",
      error: expect.stringContaining("RAGFlow is unreachable"),
    });
    expect(status.sources[0]).toMatchObject({
      state: "error",
      error: expect.stringContaining("RAGFlow is unreachable"),
    });
  });
});
