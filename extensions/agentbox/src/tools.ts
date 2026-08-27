import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { Type } from "typebox";
import type { AnyAgentTool } from "../api.js";
import type { AgentBoxService } from "./service.js";

const AgentBoxSearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  },
  { additionalProperties: false },
);
const AgentBoxSyncSchema = Type.Object({}, { additionalProperties: false });

function requireService(getService: () => AgentBoxService | null): AgentBoxService {
  const service = getService();
  if (!service) {
    throw new Error("AgentBox document service is not running.");
  }
  return service;
}

export function createAgentBoxSearchTool(getService: () => AgentBoxService | null): AnyAgentTool {
  return {
    name: "agentbox_search",
    label: "Search company documents",
    description:
      "Search the current company's authorized internal documents. Use the returned source labels as citations.",
    parameters: AgentBoxSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string; maxResults?: number };
      const results = await requireService(getService).search(params.query, params.maxResults);
      const text =
        results.length === 0
          ? "No authorized company document matched this question."
          : results
              .map((result, index) => {
                const source = result.documentName || result.documentId;
                const content = wrapExternalContent(result.content, {
                  source: "api",
                  includeWarning: false,
                });
                return `[${index + 1}] ${source}\n${content}`;
              })
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: {
          citations: results.map((result, index) => ({
            index: index + 1,
            documentId: result.documentId,
            documentName: result.documentName,
            similarity: result.similarity,
          })),
        },
      };
    },
  };
}

export function createAgentBoxSyncTool(getService: () => AgentBoxService | null): AnyAgentTool {
  return {
    name: "agentbox_sync",
    label: "Synchronize company documents",
    description: "Run an immediate read-only synchronization of configured company sources.",
    parameters: AgentBoxSyncSchema,
    execute: async () => {
      const status = await requireService(getService).runOnce();
      return {
        content: [
          {
            type: "text",
            text: status.sources
              .map(
                (source) =>
                  `${source.id}: ${source.state}; ${source.indexed} indexed, ${source.uploaded} uploaded, ${source.deleted} deleted`,
              )
              .join("\n"),
          },
        ],
        details: status,
      };
    },
  };
}
