import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import type { AgentBoxConfig } from "./config.js";
import { requireConfiguredSecret } from "./config.js";

const ragFlowEnvelopeSchema = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const uploadDocumentSchema = z
  .object({
    id: z.string(),
  })
  .passthrough();

const retrievalChunkSchema = z
  .object({
    content: z.string(),
    document_id: z.string(),
    document_keyword: z.string().optional(),
    similarity: z.number().optional(),
  })
  .passthrough();

export type AgentBoxSearchResult = {
  content: string;
  documentId: string;
  documentName?: string;
  similarity?: number;
};

export class RagFlowClient {
  private readonly policy: SsrFPolicy;
  private readonly apiKey: string;

  constructor(private readonly config: AgentBoxConfig["backend"]) {
    this.apiKey = requireConfiguredSecret(config.apiKeyEnv);
    const originPolicy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(config.baseUrl);
    if (!originPolicy) {
      throw new Error("AgentBox RAGFlow baseUrl must use HTTP or HTTPS.");
    }
    this.policy = {
      ...originPolicy,
      allowPrivateNetwork: config.allowPrivateNetwork,
    };
  }

  private endpoint(pathname: string): string {
    return new URL(pathname, `${this.config.baseUrl.replace(/\/$/u, "")}/`).toString();
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    const { response, release } = await fetchWithSsrFGuard({
      url: this.endpoint(pathname),
      init: {
        ...init,
        headers,
      },
      timeoutMs: 120_000,
      policy: this.policy,
      auditContext: "agentbox.ragflow",
    });
    try {
      const payload = ragFlowEnvelopeSchema.parse(
        await readProviderJsonResponse(response, "AgentBox RAGFlow"),
      );
      if (!response.ok || payload.code !== 0) {
        throw new Error(
          `RAGFlow request failed (${response.status}, code ${payload.code}): ${payload.message ?? "unknown error"}`,
        );
      }
      return payload.data;
    } finally {
      await release();
    }
  }

  async upload(params: {
    filename: string;
    mimeType?: string;
    bytes: Uint8Array;
    metadata: Record<string, string | number>;
  }): Promise<string> {
    const form = new FormData();
    const bytes = new Uint8Array(params.bytes.byteLength);
    bytes.set(params.bytes);
    form.append(
      "file",
      new Blob([bytes.buffer], { type: params.mimeType || "application/octet-stream" }),
      params.filename,
    );
    const data = await this.request(
      `/api/v1/datasets/${encodeURIComponent(this.config.datasetId)}/documents`,
      { method: "POST", body: form },
    );
    const first = z.array(uploadDocumentSchema).min(1).parse(data)[0];
    await this.request(
      `/api/v1/datasets/${encodeURIComponent(this.config.datasetId)}/documents/${encodeURIComponent(first.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta_fields: params.metadata }),
      },
    );
    await this.request(`/api/v1/datasets/${encodeURIComponent(this.config.datasetId)}/chunks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: [first.id] }),
    });
    return first.id;
  }

  async delete(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }
    await this.request(`/api/v1/datasets/${encodeURIComponent(this.config.datasetId)}/documents`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: documentIds }),
    });
  }

  async search(question: string, limit = 8): Promise<AgentBoxSearchResult[]> {
    const data = await this.request("/api/v1/retrieval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        dataset_ids: [this.config.datasetId],
        page: 1,
        page_size: Math.max(1, Math.min(30, Math.floor(limit))),
        highlight: false,
      }),
    });
    const parsed = z
      .object({ chunks: z.array(retrievalChunkSchema).default([]) })
      .passthrough()
      .parse(data);
    return parsed.chunks.map((chunk) => ({
      content: chunk.content,
      documentId: chunk.document_id,
      documentName: chunk.document_keyword,
      similarity: chunk.similarity,
    }));
  }
}
