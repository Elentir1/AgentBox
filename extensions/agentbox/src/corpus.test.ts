import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function openIndex(): AgentBoxIndexStore {
  const store = createTestIndexStore({ directories: temporaryDirectories });
  openStores.push(store);
  return store;
}

function tenantConfig(tenantId: string, root: string): AgentBoxConfig {
  return {
    tenantId,
    entitlements: testEntitlements(),
    index: testIndexConfig(),
    sync: { intervalMinutes: 15, maxFileBytes: 1024 * 1024 },
    sources: [{ id: "local", type: "local", root }],
  };
}

describe("AgentBox commercial corpus isolation", () => {
  it("answers a known fixture question and cannot reach another tenant's corpus", async () => {
    const acmeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-acme-"));
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-other-"));
    temporaryDirectories.push(acmeRoot, otherRoot);
    await fs.writeFile(
      path.join(acmeRoot, "leave-policy.md"),
      "Acme employees receive 25 days of paid annual leave.",
    );
    await fs.writeFile(path.join(acmeRoot, "invoice.txt"), "Invoice 1042 is payable net 30.");
    await fs.writeFile(
      path.join(otherRoot, "salary.md"),
      "Confidential salary bands for another company.",
    );

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const acmeIndex = openIndex();
    const otherIndex = openIndex();
    const acme = new AgentBoxService(
      tenantConfig("acme", acmeRoot),
      acmeIndex,
      createTestEmbedder(),
      createTestAuditStore().store,
      logger,
    );
    const other = new AgentBoxService(
      tenantConfig("other", otherRoot),
      otherIndex,
      createTestEmbedder(),
      createTestAuditStore().store,
      logger,
    );

    const acmeStatus = await acme.runOnce();
    await other.runOnce();

    expect(acmeStatus.sources[0]).toMatchObject({ state: "ready", indexed: 2 });

    const answers = await acme.search("How many leave days do employees get?", 5);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers[0]?.documentName).toBe("leave-policy.md");
    expect(answers[0]?.content).toContain("25 days");

    // Each tenant owns a separate index file, so a salary query cannot surface
    // the other company's document even when it is the better lexical match.
    const salary = await acme.search("confidential salary bands", 10);
    expect(salary.every((result) => result.documentName !== "salary.md")).toBe(true);
    expect(otherIndex.documentsForSource("local").map((entry) => entry.name)).toEqual([
      "salary.md",
    ]);
  });

  it("returns nothing rather than citing an unrelated document", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-threshold-"));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, "leave-policy.md"), "Employees receive 25 days of leave.");
    const index = openIndex();
    const service = new AgentBoxService(
      tenantConfig("acme", root),
      index,
      createTestEmbedder(),
      createTestAuditStore().store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    await service.runOnce();

    expect(await service.search("leave", 5)).not.toEqual([]);
    // An off-topic question must produce no citation at all. Cosine alone would
    // still rank the leave policy first and invent a source for it.
    expect(await service.search("quantum chromodynamics", 5)).toEqual([]);
  });

  it("keeps each tenant's index in its own database file", () => {
    const first = createTestIndexStore({ directories: temporaryDirectories });
    const second = createTestIndexStore({ directories: temporaryDirectories });
    openStores.push(first, second);

    first.putDocument(
      {
        sourceKey: "local:only-first.md",
        sourceId: "local",
        documentId: "doc-first",
        name: "only-first.md",
        fingerprint: "first",
        sizeBytes: 42,
      },
      [{ text: "holiday policy", embedding: [1, 0, 0, 0, 0, 0, 1, 0] }],
    );

    expect(first.totals()).toEqual({ documents: 1, bytes: 42 });
    expect(second.totals()).toEqual({ documents: 0, bytes: 0 });
    expect(second.search([1, 0, 0, 0, 0, 0, 1, 0], 5, 0.15)).toEqual([]);
    expect(temporaryDirectories.filter((entry) => fsSync.existsSync(entry)).length).toBeGreaterThan(
      1,
    );
  });
});
