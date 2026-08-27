import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuard = vi.fn();

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return { ...actual, fetchWithSsrFGuard };
});

const { RagFlowClient } = await import("./ragflow-client.js");

afterEach(() => {
  fetchWithSsrFGuard.mockReset();
  delete process.env.AGENTBOX_RAGFLOW_KEY;
});

function queueJson(payload: unknown) {
  fetchWithSsrFGuard.mockResolvedValueOnce({
    response: Response.json(payload),
    release: vi.fn(async () => undefined),
  });
}

describe("AgentBox RAGFlow client", () => {
  it("uploads, labels, and starts parsing a document", async () => {
    process.env.AGENTBOX_RAGFLOW_KEY = "secret";
    queueJson({ code: 0, data: [{ id: "doc-1" }] });
    queueJson({ code: 0, data: true });
    queueJson({ code: 0 });
    const client = new RagFlowClient({
      baseUrl: "https://ragflow.example.test",
      datasetId: "dataset-1",
      apiKeyEnv: "AGENTBOX_RAGFLOW_KEY",
      allowPrivateNetwork: false,
    });

    await expect(
      client.upload({
        filename: "policy.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
        metadata: { tenant_id: "acme", source_key: "drive:policy" },
      }),
    ).resolves.toBe("doc-1");

    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
    expect(fetchWithSsrFGuard.mock.calls[0]?.[0]).toMatchObject({
      url: "https://ragflow.example.test/api/v1/datasets/dataset-1/documents",
      policy: { allowedOrigins: ["https://ragflow.example.test"], allowPrivateNetwork: false },
    });
    expect(fetchWithSsrFGuard.mock.calls[2]?.[0].init.body).toBe(
      JSON.stringify({ document_ids: ["doc-1"] }),
    );
    expect(
      new Headers(fetchWithSsrFGuard.mock.calls[0]?.[0].init.headers).get("authorization"),
    ).toBe("Bearer secret");
  });

  it("returns citation-ready retrieval results", async () => {
    process.env.AGENTBOX_RAGFLOW_KEY = "secret";
    queueJson({
      code: 0,
      data: {
        chunks: [
          {
            content: "Policy text",
            document_id: "doc-1",
            document_keyword: "policy.pdf",
            similarity: 0.92,
          },
        ],
      },
    });
    const client = new RagFlowClient({
      baseUrl: "https://ragflow.example.test",
      datasetId: "dataset-1",
      apiKeyEnv: "AGENTBOX_RAGFLOW_KEY",
      allowPrivateNetwork: false,
    });

    await expect(client.search("What is the policy?")).resolves.toEqual([
      {
        content: "Policy text",
        documentId: "doc-1",
        documentName: "policy.pdf",
        similarity: 0.92,
      },
    ]);
  });
});
