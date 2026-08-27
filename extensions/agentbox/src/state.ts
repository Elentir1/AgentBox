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

type AgentBoxCursorState = {
  kind: "cursor";
  sourceId: string;
  cursor: string;
};

type AgentBoxStateRecord = AgentBoxDocumentState | AgentBoxCursorState;

export type AgentBoxStateStore = {
  documentsForSource: (sourceId: string) => Promise<AgentBoxDocumentState[]>;
  cursorForSource: (sourceId: string) => Promise<string | undefined>;
  putDocument: (entry: AgentBoxDocumentState) => Promise<void>;
  deleteDocument: (sourceKey: string) => Promise<void>;
  putCursor: (sourceId: string, cursor: string) => Promise<void>;
};

const AGENTBOX_STATE_NAMESPACE = "documents";
const AGENTBOX_STATE_MAX_ENTRIES = 50_100;

function stateKey(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function createAgentBoxStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): AgentBoxStateStore {
  const openStore = () =>
    openKeyedStore<AgentBoxStateRecord>({
      namespace: AGENTBOX_STATE_NAMESPACE,
      maxEntries: AGENTBOX_STATE_MAX_ENTRIES,
    });
  return {
    async documentsForSource(sourceId) {
      return (await openStore().entries())
        .map((entry) => entry.value)
        .filter(
          (entry): entry is AgentBoxDocumentState =>
            entry.kind === "document" && entry.sourceId === sourceId,
        );
    },
    async cursorForSource(sourceId) {
      const entry = await openStore().lookup(stateKey("cursor", sourceId));
      return entry?.kind === "cursor" ? entry.cursor : undefined;
    },
    async putDocument(entry) {
      await openStore().register(stateKey("document", entry.sourceKey), entry);
    },
    async deleteDocument(sourceKey) {
      await openStore().delete(stateKey("document", sourceKey));
    },
    async putCursor(sourceId, cursor) {
      await openStore().register(stateKey("cursor", sourceId), {
        kind: "cursor",
        sourceId,
        cursor,
      });
    },
  };
}
