import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBoxConfig } from "./config.js";
import { AgentBoxService } from "./service.js";
import type { AgentBoxAuditEvent, AgentBoxDocumentState, AgentBoxStateStore } from "./state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function createIsolatedStore(): AgentBoxStateStore {
  const documents = new Map<string, AgentBoxDocumentState>();
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

describe("AgentBox commercial corpus isolation", () => {
  it("answers a known fixture question and never cites another tenant's document", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-corpus-"));
    temporaryDirectories.push(root);
    await fs.writeFile(
      path.join(root, "leave-policy.md"),
      "Acme employees receive 25 days of paid annual leave.",
    );
    await fs.writeFile(path.join(root, "invoice.txt"), "Invoice 1042 is payable net 30.");

    const acmeStore = createIsolatedStore();
    const otherStore = createIsolatedStore();
    await otherStore.putDocument({
      kind: "document",
      sourceId: "local",
      sourceKey: "local:salary.xlsx",
      fingerprint: "foreign",
      documentId: "doc-salary-other",
      name: "salary.xlsx",
    });

    const config: AgentBoxConfig = {
      tenantId: "acme",
      backend: {
        baseUrl: "https://ragflow.example.test",
        datasetId: "acme",
        apiKeyEnv: "RAGFLOW_API_KEY",
        allowPrivateNetwork: false,
      },
      sync: { intervalMinutes: 15, maxFileBytes: 1024 * 1024 },
      sources: [{ id: "local", type: "local", root }],
    };
    const uploaded = new Map<string, string>();
    const acme = new AgentBoxService(
      config,
      acmeStore,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload: async ({ filename }) => {
            const documentId = `doc-${filename}`;
            uploaded.set(filename, documentId);
            return documentId;
          },
          delete: vi.fn(async () => undefined),
          search: async (question) => {
            expect(question).toContain("leave");
            return [
              {
                content: "Acme employees receive 25 days of paid annual leave.",
                documentId: uploaded.get("leave-policy.md") ?? "missing",
                documentName: "leave-policy.md",
                similarity: 0.97,
              },
              {
                content: "Confidential salary bands for another company.",
                documentId: "doc-salary-other",
                documentName: "salary.xlsx",
                similarity: 0.99,
              },
            ];
          },
        },
      },
    );

    const status = await acme.runOnce();
    const results = await acme.search("How many leave days do employees receive?");

    expect(status.sources[0]?.indexed).toBe(2);
    expect(results).toEqual([
      expect.objectContaining({
        documentName: "leave-policy.md",
        content: "Acme employees receive 25 days of paid annual leave.",
      }),
    ]);
    expect(results.some((result) => result.documentId === "doc-salary-other")).toBe(false);
    await expect(otherStore.authorizedDocumentIds()).resolves.toEqual(
      new Set(["doc-salary-other"]),
    );
    await expect(acmeStore.authorizedDocumentIds()).resolves.not.toContain("doc-salary-other");
  });
});
