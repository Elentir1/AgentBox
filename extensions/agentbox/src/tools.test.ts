import { describe, expect, it, vi } from "vitest";
import { AgentBoxService } from "./service.js";
import type { AgentBoxDocumentState, AgentBoxStateStore } from "./state.js";
import { createAgentBoxSearchTool } from "./tools.js";

describe("AgentBox search tool", () => {
  it("returns numbered citations for authorized company documents", async () => {
    const state: AgentBoxStateStore = {
      documentsForSource: async () => [],
      authorizedDocumentIds: async () => new Set(["doc-leave"]),
      cursorForSource: async () => undefined,
      putDocument: async () => undefined,
      deleteDocument: async () => undefined,
      putCursor: async () => undefined,
      appendAudit: async () => undefined,
      listAudit: async () => [],
    };
    const indexed: AgentBoxDocumentState = {
      kind: "document",
      sourceId: "local",
      sourceKey: "local:leave-policy.md",
      fingerprint: "policy",
      documentId: "doc-leave",
      name: "leave-policy.md",
    };
    await state.putDocument(indexed);
    const service = new AgentBoxService(
      {
        tenantId: "acme",
        backend: {
          baseUrl: "https://ragflow.example.test",
          datasetId: "acme",
          apiKeyEnv: "RAGFLOW_API_KEY",
          allowPrivateNetwork: false,
        },
        sync: { intervalMinutes: 15, maxFileBytes: 1024 },
        sources: [{ id: "local", type: "local", root: "/documents" }],
      },
      {
        ...state,
        authorizedDocumentIds: async () => new Set(["doc-leave"]),
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        client: {
          upload: vi.fn(async () => "unused"),
          delete: vi.fn(async () => undefined),
          search: vi.fn(async () => [
            {
              content: "Employees receive 25 days of paid leave.",
              documentId: "doc-leave",
              documentName: "leave-policy.md",
              similarity: 0.9,
            },
          ]),
        },
      },
    );
    const tool = createAgentBoxSearchTool(() => service);

    const result = await tool.execute("call-1", { query: "leave days" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[1] leave-policy.md"),
    });
    expect(result.details).toEqual({
      citations: [
        {
          index: 1,
          documentId: "doc-leave",
          documentName: "leave-policy.md",
          similarity: 0.9,
        },
      ],
    });
  });
});
