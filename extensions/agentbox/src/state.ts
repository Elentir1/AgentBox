import { createHash } from "node:crypto";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export type AgentBoxDocumentState = {
  kind: "document";
  sourceId: string;
  sourceKey: string;
  fingerprint: string;
  documentId: string;
  name: string;
  sourceUrl?: string;
};

export type AgentBoxAuditEvent = {
  kind: "audit";
  at: string;
  action: "search" | "sync";
  actor: string;
  tenantId: string;
  queryDigest?: string;
  queryPreview?: string;
  resultCount?: number;
  droppedCount?: number;
  documentIds?: string[];
  uploaded?: number;
  deleted?: number;
};

type AgentBoxCursorState = {
  kind: "cursor";
  sourceId: string;
  cursor: string;
};

type AgentBoxDocumentRecord = AgentBoxDocumentState | AgentBoxCursorState;

export type AgentBoxStateStore = {
  documentsForSource: (sourceId: string) => Promise<AgentBoxDocumentState[]>;
  authorizedDocumentIds: () => Promise<Set<string>>;
  cursorForSource: (sourceId: string) => Promise<string | undefined>;
  putDocument: (entry: AgentBoxDocumentState) => Promise<void>;
  deleteDocument: (sourceKey: string) => Promise<void>;
  putCursor: (sourceId: string, cursor: string) => Promise<void>;
  appendAudit: (event: AgentBoxAuditEvent) => Promise<void>;
  listAudit: (limit?: number) => Promise<AgentBoxAuditEvent[]>;
};

const AGENTBOX_STATE_NAMESPACE = "documents";
const AGENTBOX_AUDIT_NAMESPACE = "audit";
const AGENTBOX_STATE_MAX_ENTRIES = 50_100;
const AGENTBOX_AUDIT_MAX_ENTRIES = 10_000;
const AGENTBOX_AUDIT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function stateKey(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestSearchQuery(query: string): { queryDigest: string; queryPreview: string } {
  const normalized = query.trim().replace(/\s+/gu, " ");
  return {
    queryDigest: createHash("sha256").update(normalized, "utf8").digest("hex"),
    queryPreview: normalized.slice(0, 80),
  };
}

export function createAgentBoxStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): AgentBoxStateStore {
  const openDocuments = () =>
    openKeyedStore<AgentBoxDocumentRecord>({
      namespace: AGENTBOX_STATE_NAMESPACE,
      maxEntries: AGENTBOX_STATE_MAX_ENTRIES,
    });
  const openAudit = () =>
    openKeyedStore<AgentBoxAuditEvent>({
      namespace: AGENTBOX_AUDIT_NAMESPACE,
      maxEntries: AGENTBOX_AUDIT_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: AGENTBOX_AUDIT_TTL_MS,
    });
  return {
    async documentsForSource(sourceId) {
      return (await openDocuments().entries())
        .map((entry) => entry.value)
        .filter(
          (entry): entry is AgentBoxDocumentState =>
            entry.kind === "document" && entry.sourceId === sourceId,
        );
    },
    async authorizedDocumentIds() {
      return new Set(
        (await openDocuments().entries())
          .map((entry) => entry.value)
          .filter((entry): entry is AgentBoxDocumentState => entry.kind === "document")
          .map((entry) => entry.documentId),
      );
    },
    async cursorForSource(sourceId) {
      const entry = await openDocuments().lookup(stateKey("cursor", sourceId));
      return entry?.kind === "cursor" ? entry.cursor : undefined;
    },
    async putDocument(entry) {
      await openDocuments().register(stateKey("document", entry.sourceKey), entry);
    },
    async deleteDocument(sourceKey) {
      await openDocuments().delete(stateKey("document", sourceKey));
    },
    async putCursor(sourceId, cursor) {
      await openDocuments().register(stateKey("cursor", sourceId), {
        kind: "cursor",
        sourceId,
        cursor,
      });
    },
    async appendAudit(event) {
      await openAudit().register(stateKey("audit", `${event.at}:${event.action}:${event.actor}`), {
        ...event,
        kind: "audit",
      });
    },
    async listAudit(limit = 50) {
      const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
      return (await openAudit().entries())
        .map((entry) => entry.value)
        .filter((entry) => entry.kind === "audit")
        .toSorted((left, right) => right.at.localeCompare(left.at))
        .slice(0, bounded);
    },
  };
}
