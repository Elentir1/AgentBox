import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBoxConfig } from "./config.js";
import type { AgentBoxIndexStore } from "./index-store.js";
import { AgentBoxService } from "./service.js";
import {
  createTestAuditStore,
  createTestEmbedder,
  createTestIndexStore,
  embedForTests,
  testEntitlements,
  testIndexConfig,
} from "./test-helpers.js";
import { createAgentBoxSearchTool } from "./tools.js";

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

const config: AgentBoxConfig = {
  tenantId: "acme",
  entitlements: testEntitlements(),
  index: testIndexConfig(),
  sync: { intervalMinutes: 15, maxFileBytes: 1024 },
  sources: [{ id: "local", type: "local", root: "/documents" }],
};

function createService(seed: (store: AgentBoxIndexStore) => void): AgentBoxService {
  const store = createTestIndexStore({ directories: temporaryDirectories });
  openStores.push(store);
  seed(store);
  return new AgentBoxService(config, store, createTestEmbedder(), createTestAuditStore().store, {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
}

describe("AgentBox search tool", () => {
  it("returns numbered citations for indexed company documents", async () => {
    const service = createService((store) => {
      const text = "Employees receive 25 days of paid leave each year.";
      store.putDocument(
        {
          sourceKey: "local:leave-policy.md",
          sourceId: "local",
          documentId: "doc-leave",
          name: "leave-policy.md",
          fingerprint: "policy",
          sizeBytes: text.length,
        },
        [{ text, embedding: embedForTests(text) }],
      );
    });
    const tool = createAgentBoxSearchTool(() => service);

    const result = await tool.execute("call-1", { query: "how much leave?" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("[1] leave-policy.md");
    expect(text).toContain("25 days");
    expect((result.details as { citations?: unknown }).citations).toMatchObject([
      { index: 1, documentId: "doc-leave" },
    ]);
  });

  it("tells the model when the company corpus has no match", async () => {
    const service = createService(() => undefined);
    const tool = createAgentBoxSearchTool(() => service);

    const result = await tool.execute("call-2", { query: "how much leave?" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toBe("No authorized company document matched this question.");
    expect((result.details as { citations?: unknown }).citations).toEqual([]);
  });
});
