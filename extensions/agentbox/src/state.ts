import { createHash } from "node:crypto";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export type AgentBoxAuditEvent = {
  kind: "audit";
  at: string;
  action: "search" | "sync";
  actor: string;
  tenantId: string;
  queryDigest?: string;
  queryPreview?: string;
  resultCount?: number;
  documentIds?: string[];
  uploaded?: number;
  deleted?: number;
};

export type AgentBoxAuditStore = {
  append: (event: AgentBoxAuditEvent) => Promise<void>;
  list: (limit?: number) => Promise<AgentBoxAuditEvent[]>;
};

const AGENTBOX_AUDIT_NAMESPACE = "audit";
const AGENTBOX_AUDIT_MAX_ENTRIES = 10_000;
const AGENTBOX_AUDIT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function auditKey(value: string): string {
  return `audit:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestSearchQuery(query: string): { queryDigest: string; queryPreview: string } {
  const normalized = query.trim().replace(/\s+/gu, " ");
  return {
    queryDigest: createHash("sha256").update(normalized, "utf8").digest("hex"),
    queryPreview: normalized.slice(0, 80),
  };
}

/**
 * The audit trail is a bounded, expiring log, which is what the plugin state
 * store is for. The document corpus lives in the plugin's own SQLite index
 * instead: chunk counts exceed the per-plugin entry budget by design.
 */
export function createAgentBoxAuditStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): AgentBoxAuditStore {
  const open = () =>
    openKeyedStore<AgentBoxAuditEvent>({
      namespace: AGENTBOX_AUDIT_NAMESPACE,
      maxEntries: AGENTBOX_AUDIT_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: AGENTBOX_AUDIT_TTL_MS,
    });
  return {
    async append(event) {
      await open().register(auditKey(`${event.at}:${event.action}:${event.actor}`), event);
    },
    async list(limit = 50) {
      const entries = await open().entries();
      return entries
        .map((entry) => entry.value)
        .toSorted((left, right) => right.at.localeCompare(left.at))
        .slice(0, limit);
    },
  };
}
