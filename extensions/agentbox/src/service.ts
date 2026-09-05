import type { AgentBoxConfig, AgentBoxEntitlements } from "./config.js";
import type {
  AgentBoxIndexMatch,
  AgentBoxIndexStore,
  AgentBoxIndexedDocument,
} from "./index-store.js";
import { chunkDocumentText, extractDocumentText, type AgentBoxEmbedder } from "./indexer.js";
import { createSourceAdapter, type AgentBoxDocument } from "./sources.js";
import { digestSearchQuery, type AgentBoxAuditStore } from "./state.js";

type AgentBoxLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type AgentBoxSearchResult = {
  content: string;
  documentId: string;
  documentName?: string;
  sourceUrl?: string;
  similarity?: number;
};

export type AgentBoxIndexStatus = {
  state: "ready" | "error";
  error?: string;
};

export type AgentBoxSourceStatus = {
  id: string;
  type: AgentBoxConfig["sources"][number]["type"];
  state: "idle" | "syncing" | "ready" | "error";
  indexed: number;
  uploaded: number;
  deleted: number;
  skipped: number;
  unsupported: number;
  lastSyncAt?: string;
  error?: string;
};

export type AgentBoxSubscriptionStatus = {
  planId: string;
  state: AgentBoxEntitlements["status"];
  validUntil?: string;
  quotas: AgentBoxEntitlements["quotas"];
  usage: { documents: number; bytes: number };
};

export type AgentBoxStatus = {
  tenantId: string;
  running: boolean;
  syncInProgress: boolean;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  subscription: AgentBoxSubscriptionStatus;
  index: AgentBoxIndexStatus;
  sources: AgentBoxSourceStatus[];
};

/** Remaining corpus headroom for one sync pass, shared across every source. */
type AgentBoxQuotaBudget = { documents: number; bytes: number };

export class AgentBoxService {
  private readonly sourceStatuses: AgentBoxSourceStatus[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private syncPromise: Promise<AgentBoxStatus> | undefined;
  private running = false;
  private lastSyncStartedAt: string | undefined;
  private lastSyncCompletedAt: string | undefined;
  private indexStatus: AgentBoxIndexStatus = { state: "ready" };
  private usage: AgentBoxSubscriptionStatus["usage"] = { documents: 0, bytes: 0 };
  private readonly createAdapter: typeof createSourceAdapter;

  constructor(
    private readonly config: AgentBoxConfig,
    private readonly index: AgentBoxIndexStore,
    private readonly embedder: AgentBoxEmbedder,
    private readonly audit: AgentBoxAuditStore,
    private readonly logger: AgentBoxLogger,
    dependencies: { createAdapter?: typeof createSourceAdapter } = {},
  ) {
    this.createAdapter = dependencies.createAdapter ?? createSourceAdapter;
    this.sourceStatuses = config.sources.map((source) => ({
      id: source.id,
      type: source.type,
      state: "idle",
      indexed: 0,
      uploaded: 0,
      deleted: 0,
      skipped: 0,
      unsupported: 0,
    }));
    this.usage = this.index.totals();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.runOnce().catch((error: unknown) => {
      this.logger.error(`AgentBox initial sync failed: ${this.errorMessage(error)}`);
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  status(): AgentBoxStatus {
    return {
      tenantId: this.config.tenantId,
      running: this.running,
      syncInProgress: Boolean(this.syncPromise),
      lastSyncStartedAt: this.lastSyncStartedAt,
      lastSyncCompletedAt: this.lastSyncCompletedAt,
      subscription: {
        planId: this.config.entitlements.planId,
        state: this.config.entitlements.status,
        validUntil: this.config.entitlements.validUntil,
        quotas: { ...this.config.entitlements.quotas },
        usage: { ...this.usage },
      },
      index: { ...this.indexStatus },
      sources: this.sourceStatuses.map((source) => ({ ...source })),
    };
  }

  async refreshStatus(): Promise<AgentBoxStatus> {
    this.usage = this.index.totals();
    return this.status();
  }

  async search(
    question: string,
    limit?: number,
    actor = "agent-tool",
  ): Promise<AgentBoxSearchResult[]> {
    this.requireActiveSubscription();
    const queryEmbedding = await this.embedder.embedQuery(question);
    // Retrieval reads this tenant's own index only. There is no shared corpus to
    // filter, so a match cannot originate from another customer's documents.
    const matches: AgentBoxIndexMatch[] = this.index.search(
      queryEmbedding,
      typeof limit === "number" ? limit : 8,
      this.config.index.minSimilarity,
    );
    await this.audit.append({
      kind: "audit",
      at: new Date().toISOString(),
      action: "search",
      actor,
      tenantId: this.config.tenantId,
      ...digestSearchQuery(question),
      resultCount: matches.length,
      documentIds: matches.map((match) => match.documentId),
    });
    return matches;
  }

  async auditTrail(limit?: number) {
    return await this.audit.list(limit);
  }

  runOnce(): Promise<AgentBoxStatus> {
    if (this.syncPromise) {
      return this.syncPromise;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = undefined;
      // Schedule only after the active pass completes; overlapping source scans
      // can advance cursors out of order and permanently skip document changes.
      if (this.running) {
        this.timer = setTimeout(
          () =>
            void this.runOnce().catch((error: unknown) => {
              this.logger.error(`AgentBox scheduled sync failed: ${this.errorMessage(error)}`);
            }),
          this.config.sync.intervalMinutes * 60_000,
        );
      }
    });
    return this.syncPromise;
  }

  private async performSync(): Promise<AgentBoxStatus> {
    this.lastSyncStartedAt = new Date().toISOString();
    this.usage = this.index.totals();
    // A suspended tenant is meant to have a stopped Gateway. Refusing to scan is
    // the second line of defence when the control plane failed to stop this one.
    if (this.config.entitlements.status === "suspended") {
      this.logger.warn(
        `AgentBox skipped synchronization: plan ${this.config.entitlements.planId} is suspended.`,
      );
      this.lastSyncCompletedAt = new Date().toISOString();
      return this.status();
    }
    const budget: AgentBoxQuotaBudget = {
      documents: this.config.entitlements.quotas.maxDocuments - this.usage.documents,
      bytes: this.config.entitlements.quotas.maxStorageBytes - this.usage.bytes,
    };
    for (const source of this.config.sources) {
      const status = this.sourceStatuses.find((entry) => entry.id === source.id);
      if (!status) {
        continue;
      }
      status.state = "syncing";
      status.error = undefined;
      status.uploaded = 0;
      status.deleted = 0;
      status.skipped = 0;
      status.unsupported = 0;
      try {
        await this.syncSource(source.id, status, budget);
        status.state = "ready";
        status.lastSyncAt = new Date().toISOString();
      } catch (error) {
        status.state = "error";
        status.error = this.errorMessage(error);
        this.logger.warn(`AgentBox source ${source.id} sync failed: ${status.error}`);
      }
    }
    this.lastSyncCompletedAt = new Date().toISOString();
    this.usage = this.index.totals();
    const status = this.status();
    await this.audit.append({
      kind: "audit",
      at: this.lastSyncCompletedAt,
      action: "sync",
      actor: "scheduler",
      tenantId: this.config.tenantId,
      uploaded: status.sources.reduce((sum, source) => sum + source.uploaded, 0),
      deleted: status.sources.reduce((sum, source) => sum + source.deleted, 0),
    });
    return status;
  }

  private async syncSource(
    sourceId: string,
    status: AgentBoxSourceStatus,
    budget: AgentBoxQuotaBudget,
  ): Promise<void> {
    const sourceConfig = this.config.sources.find((source) => source.id === sourceId);
    if (!sourceConfig) {
      throw new Error(`Unknown AgentBox source ${sourceId}.`);
    }
    const adapter = this.createAdapter(sourceConfig);
    const cursor = this.index.cursorForSource(sourceId);
    const scan = await adapter.scan(cursor);
    const previous = this.index.documentsForSource(sourceId);
    const previousByKey = new Map(previous.map((entry) => [entry.sourceKey, entry]));
    const incomingByKey = new Map<string, AgentBoxDocument>();
    for (const document of scan.documents) {
      incomingByKey.set(document.key, document);
    }
    const deletedKeys = new Set(scan.deletedKeys);
    if (scan.mode === "snapshot") {
      for (const key of previousByKey.keys()) {
        if (!incomingByKey.has(key)) {
          deletedKeys.add(key);
        }
      }
    }
    for (const key of deletedKeys) {
      const entry = previousByKey.get(key);
      if (!entry) {
        continue;
      }
      this.index.deleteDocument(key);
      previousByKey.delete(key);
      budget.documents += 1;
      budget.bytes += entry.sizeBytes;
      status.deleted += 1;
    }
    for (const document of incomingByKey.values()) {
      if (document.size > this.config.sync.maxFileBytes) {
        throw new Error(
          `${document.name} exceeds the configured ${this.config.sync.maxFileBytes} byte limit.`,
        );
      }
      const existing = previousByKey.get(document.key);
      if (existing?.fingerprint === document.fingerprint) {
        status.skipped += 1;
        continue;
      }
      // Replacing a document returns its slot to the budget before the new copy
      // is measured, so an in-place update never counts twice against the plan.
      const replacedBytes = existing?.sizeBytes ?? 0;
      const replacedDocuments = existing ? 1 : 0;
      const bytes = await document.read();
      if (bytes.byteLength > this.config.sync.maxFileBytes) {
        throw new Error(
          `${document.name} download exceeds the configured ${this.config.sync.maxFileBytes} byte limit.`,
        );
      }
      this.requireQuotaHeadroom(document.name, bytes.byteLength, budget, {
        replacedBytes,
        replacedDocuments,
      });
      const text = await extractDocumentText({
        bytes,
        fileName: document.name,
        ...(document.mimeType ? { mimeType: document.mimeType } : {}),
      });
      if (text === null) {
        status.unsupported += 1;
        continue;
      }
      const chunks = chunkDocumentText(text, this.config.index.chunk);
      if (chunks.length === 0) {
        status.unsupported += 1;
        continue;
      }
      const embeddings = await this.embedder.embedDocuments(chunks);
      const record: AgentBoxIndexedDocument = {
        sourceKey: document.key,
        sourceId,
        documentId: existing?.documentId ?? `${sourceId}:${document.key}`,
        name: document.name,
        fingerprint: document.fingerprint,
        ...(document.sourceUrl ? { sourceUrl: document.sourceUrl } : {}),
        sizeBytes: bytes.byteLength,
      };
      this.index.putDocument(
        record,
        chunks.map((chunk, ordinal) => ({ text: chunk, embedding: embeddings[ordinal] ?? [] })),
      );
      budget.documents += replacedDocuments - 1;
      budget.bytes += replacedBytes - bytes.byteLength;
      status.uploaded += 1;
    }
    if (scan.cursor) {
      this.index.putCursor(sourceId, scan.cursor);
    }
    status.indexed = this.index.documentsForSource(sourceId).length;
    this.logger.info(
      `AgentBox source ${sourceId}: ${status.uploaded} indexed, ${status.deleted} deleted, ${status.skipped} unchanged, ${status.unsupported} unsupported.`,
    );
  }

  private requireActiveSubscription(): void {
    if (this.config.entitlements.status === "suspended") {
      throw new Error(
        `AgentBox is suspended for tenant ${this.config.tenantId}. Contact AlpenData to restore the subscription.`,
      );
    }
  }

  /**
   * Refuses the document that would cross a plan limit instead of trimming the
   * corpus. The caller turns this into a source error, so files already indexed
   * stay searchable and going over quota never destroys customer data.
   */
  private requireQuotaHeadroom(
    name: string,
    sizeBytes: number,
    budget: AgentBoxQuotaBudget,
    replaced: { replacedBytes: number; replacedDocuments: number },
  ): void {
    const quotas = this.config.entitlements.quotas;
    if (budget.documents + replaced.replacedDocuments < 1) {
      throw new Error(
        `Plan ${this.config.entitlements.planId} allows ${quotas.maxDocuments} indexed documents. ${name} was not indexed. Upgrade the plan or remove documents from the source.`,
      );
    }
    if (budget.bytes + replaced.replacedBytes < sizeBytes) {
      throw new Error(
        `Plan ${this.config.entitlements.planId} allows ${quotas.maxStorageBytes} indexed bytes. ${name} was not indexed. Upgrade the plan or remove documents from the source.`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
