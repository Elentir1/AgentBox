import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBoxConfig } from "./config.js";
import type { AgentBoxIndexStore } from "./index-store.js";
import { AgentBoxService } from "./service.js";
import {
  createTestAuditStore,
  createTestEmbedder,
  createTestIndexStore,
  testEntitlements,
  testIndexConfig,
} from "./test-helpers.js";

const temporaryDirectories: string[] = [];
const openStores: AgentBoxIndexStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function openIndex(identity?: string): AgentBoxIndexStore {
  const store = createTestIndexStore({
    directories: temporaryDirectories,
    ...(identity ? { identity } : {}),
  });
  openStores.push(store);
  return store;
}

const localConfig: AgentBoxConfig = {
  tenantId: "acme",
  entitlements: testEntitlements(),
  index: testIndexConfig(),
  sync: { intervalMinutes: 15, maxFileBytes: 1024 },
  sources: [{ id: "local", type: "local", root: "/documents" }],
};

function documentFixture(params: { key: string; name: string; text: string; fingerprint: string }) {
  const bytes = new TextEncoder().encode(params.text);
  return {
    key: params.key,
    name: params.name,
    mimeType: "text/markdown",
    fingerprint: params.fingerprint,
    size: bytes.byteLength,
    modifiedAtMs: 1,
    read: async () => bytes,
  };
}

function scanning(
  documents: ReturnType<typeof documentFixture>[],
  options: { mode?: "delta" | "snapshot"; deletedKeys?: string[] } = {},
) {
  return (source: { id: string }) => ({
    id: source.id,
    async scan() {
      return {
        mode: options.mode ?? "delta",
        documents,
        deletedKeys: options.deletedKeys ?? [],
      };
    },
  });
}

describe("AgentBox synchronization", () => {
  it("indexes documents and answers from the tenant's own corpus", async () => {
    const index = openIndex();
    const audit = createTestAuditStore();
    const service = new AgentBoxService(
      localConfig,
      index,
      createTestEmbedder(),
      audit.store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        createAdapter: scanning([
          documentFixture({
            key: "local:leave-policy.md",
            name: "leave-policy.md",
            text: "Employees receive 25 days of paid leave each year.",
            fingerprint: "leave-1",
          }),
          documentFixture({
            key: "local:invoice.txt",
            name: "invoice.txt",
            text: "Invoice 1042 is payable net 30.",
            fingerprint: "invoice-1",
          }),
        ]) as never,
      },
    );

    const status = await service.runOnce();
    expect(status.sources[0]).toMatchObject({ state: "ready", uploaded: 2, indexed: 2 });
    expect(status.subscription.usage.documents).toBe(2);
    expect(status.subscription.usage.bytes).toBeGreaterThan(0);

    const results = await service.search("how much leave do we get?", 1, "employee@203.0.113.10");
    expect(results[0]?.documentName).toBe("leave-policy.md");
    expect(results[0]?.content).toContain("25 days");

    expect(audit.events[0]).toMatchObject({ action: "sync", uploaded: 2, deleted: 0 });
    const searchEvent = audit.events.at(-1);
    expect(searchEvent).toMatchObject({
      action: "search",
      actor: "employee@203.0.113.10",
      resultCount: 1,
    });
    expect(searchEvent?.queryDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("skips unchanged files and removes snapshot tombstones", async () => {
    const index = openIndex();
    const audit = createTestAuditStore();
    const kept = documentFixture({
      key: "local:leave-policy.md",
      name: "leave-policy.md",
      text: "Employees receive 25 days of paid leave each year.",
      fingerprint: "leave-1",
    });
    const removed = documentFixture({
      key: "local:invoice.txt",
      name: "invoice.txt",
      text: "Invoice 1042 is payable net 30.",
      fingerprint: "invoice-1",
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const first = new AgentBoxService(
      localConfig,
      index,
      createTestEmbedder(),
      audit.store,
      logger,
      { createAdapter: scanning([kept, removed]) as never },
    );
    await first.runOnce();

    const second = new AgentBoxService(
      localConfig,
      index,
      createTestEmbedder(),
      audit.store,
      logger,
      {
        createAdapter: scanning([kept], { mode: "snapshot" }) as never,
      },
    );
    const status = await second.runOnce();

    expect(status.sources[0]).toMatchObject({ skipped: 1, deleted: 1, uploaded: 0, indexed: 1 });
    expect(status.subscription.usage.documents).toBe(1);
    const results = await second.search("invoice", 5);
    expect(results.every((result) => result.documentName !== "invoice.txt")).toBe(true);
  });

  it("stops a source at the document quota without deleting what is indexed", async () => {
    const index = openIndex();
    const audit = createTestAuditStore();
    const seed = new AgentBoxService(
      localConfig,
      index,
      createTestEmbedder(),
      audit.store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        createAdapter: scanning([
          documentFixture({
            key: "local:kept.md",
            name: "kept.md",
            text: "The holiday policy is generous.",
            fingerprint: "kept-1",
          }),
        ]) as never,
      },
    );
    await seed.runOnce();

    const cappedConfig: AgentBoxConfig = {
      ...localConfig,
      entitlements: testEntitlements({
        quotas: { ...testEntitlements().quotas, maxDocuments: 1 },
      }),
    };
    const capped = new AgentBoxService(
      cappedConfig,
      index,
      createTestEmbedder(),
      audit.store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        createAdapter: scanning([
          documentFixture({
            key: "local:kept.md",
            name: "kept.md",
            text: "The holiday policy is generous.",
            fingerprint: "kept-1",
          }),
          documentFixture({
            key: "local:new.md",
            name: "new.md",
            text: "A new expense policy.",
            fingerprint: "new-1",
          }),
        ]) as never,
      },
    );

    const status = await capped.runOnce();

    expect(status.sources[0]).toMatchObject({
      state: "error",
      error: expect.stringContaining("1 indexed documents"),
    });
    expect(status.subscription.usage.documents).toBe(1);
    expect(index.documentsForSource("local").map((entry) => entry.name)).toEqual(["kept.md"]);
  });

  it("refuses to scan or search while the subscription is suspended", async () => {
    const index = openIndex();
    const audit = createTestAuditStore();
    const scan = vi.fn();
    const service = new AgentBoxService(
      { ...localConfig, entitlements: testEntitlements({ status: "suspended" }) },
      index,
      createTestEmbedder(),
      audit.store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { createAdapter: (source) => ({ id: source.id, scan: scan as never }) },
    );

    const status = await service.runOnce();

    expect(scan).not.toHaveBeenCalled();
    expect(status.subscription.state).toBe("suspended");
    await expect(service.search("anything")).rejects.toThrow("suspended");
  });

  it("rebuilds the corpus when the embedding identity changes", async () => {
    const index = openIndex("test://embeddings#v1");
    const audit = createTestAuditStore();
    const adapter = scanning([
      documentFixture({
        key: "local:leave-policy.md",
        name: "leave-policy.md",
        text: "Employees receive 25 days of paid leave each year.",
        fingerprint: "leave-1",
      }),
    ]);
    const service = new AgentBoxService(
      localConfig,
      index,
      createTestEmbedder(),
      audit.store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { createAdapter: adapter as never },
    );
    await service.runOnce();
    expect(index.totals().documents).toBe(1);
    const databasePath = `${temporaryDirectories.at(-1)}/agentbox-index.sqlite`;
    index.close();
    openStores.pop();

    // Vectors from a different embedding space are not comparable, so reopening
    // under a new identity must drop the corpus rather than mix the two.
    const { openAgentBoxIndexStore } = await import("./index-store.js");
    const reopened = openAgentBoxIndexStore({
      embeddingIdentity: "test://embeddings#v2",
      databasePath,
    });
    openStores.push(reopened);

    expect(reopened.totals().documents).toBe(0);
    expect(reopened.cursorForSource("local")).toBeUndefined();
  });
});
