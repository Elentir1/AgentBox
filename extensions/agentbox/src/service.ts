import { isTenantScopedDataset, type AgentBoxConfig, type AgentBoxEntitlements } from "./config.js";
import { RagFlowClient, type AgentBoxSearchResult } from "./ragflow-client.js";
import { createSourceAdapter, type AgentBoxDocument } from "./sources.js";
import { digestSearchQuery, type AgentBoxDocumentState, type AgentBoxStateStore } from "./state.js";

type AgentBoxLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type AgentBoxDocumentClient = Pick<RagFlowClient, "delete" | "search" | "upload"> &
  Partial<Pick<RagFlowClient, "inspect">>;

export type AgentBoxBackendStatus = {
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
  lastSyncAt?: string;
  error?: string;
};

/**
 * Documents indexed before quotas shipped carry no recorded size, so the total is
 * reported as partial rather than as a smaller measured number. An operator must
 * be able to tell "10 GB used" from "10 GB plus 40 files we have not sized yet".
 */
export type AgentBoxStorageUsage =
  | { kind: "measured"; bytes: number }
  | { kind: "partial"; bytes: number; unmeasuredDocuments: number };

export type AgentBoxSubscriptionStatus = {
  planId: string;
  state: AgentBoxEntitlements["status"];
  validUntil?: string;
  quotas: AgentBoxEntitlements["quotas"];
  usage: { documents: number; storage: AgentBoxStorageUsage };
};

export type AgentBoxStatus = {
  tenantId: string;
  running: boolean;
  syncInProgress: boolean;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  subscription: AgentBoxSubscriptionStatus;
  backend: AgentBoxBackendStatus;
  sources: AgentBoxSourceStatus[];
};

/** Remaining corpus headroom for one sync pass, shared across every source. */
type AgentBoxQuotaBudget = { documents: number; bytes: number };

export class AgentBoxService {
  private readonly client: AgentBoxDocumentClient;
  private readonly sourceStatuses: AgentBoxSourceStatus[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private syncPromise: Promise<AgentBoxStatus> | undefined;
  private running = false;
  private lastSyncStartedAt: string | undefined;
  private lastSyncCompletedAt: string | undefined;
  private backendStatus: AgentBoxBackendStatus = {
    state: "error",
    error: "RAGFlow has not been checked yet.",
  };
  private usage: AgentBoxSubscriptionStatus["usage"] = {
    documents: 0,
    storage: { kind: "measured", bytes: 0 },
  };
  private readonly createAdapter: typeof createSourceAdapter;

  constructor(
    private readonly config: AgentBoxConfig,
    private readonly state: AgentBoxStateStore,
    private readonly logger: AgentBoxLogger,
    dependencies: {
      client?: AgentBoxDocumentClient;
      createAdapter?: typeof createSourceAdapter;
    } = {},
  ) {
    this.client = dependencies.client ?? new RagFlowClient(config.backend);
    this.createAdapter = dependencies.createAdapter ?? createSourceAdapter;
    this.sourceStatuses = config.sources.map((source) => ({
      id: source.id,
      type: source.type,
      state: "idle",
      indexed: 0,
      uploaded: 0,
      deleted: 0,
      skipped: 0,
    }));
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
        usage: this.usage,
      },
      backend: { ...this.backendStatus },
      sources: this.sourceStatuses.map((source) => ({ ...source })),
    };
  }

  async refreshStatus(): Promise<AgentBoxStatus> {
    this.usage = await this.readUsage();
    this.backendStatus = await this.probeBackend();
    return this.status();
  }

  async search(
    question: string,
    limit?: number,
    actor = "agent-tool",
  ): Promise<AgentBoxSearchResult[]> {
    this.requireActiveSubscription();
    const raw = await this.client.search(question, limit);
    // Retrieval is bound to this instance's indexed document IDs. RAGFlow dataset
    // isolation is the primary boundary; this filter fails closed if a foreign
    // chunk leaks through the shared retrieval API.
    const authorized = await this.state.authorizedDocumentIds();
    const allowed = raw.filter((result) => authorized.has(result.documentId));
    const droppedCount = raw.length - allowed.length;
    if (droppedCount > 0) {
      this.logger.warn(`AgentBox dropped ${droppedCount} unauthorized retrieval chunks.`);
    }
    await this.state.appendAudit({
      kind: "audit",
      at: new Date().toISOString(),
      action: "search",
      actor,
      tenantId: this.config.tenantId,
      ...digestSearchQuery(question),
      resultCount: allowed.length,
      droppedCount,
      documentIds: allowed.map((result) => result.documentId),
    });
    return allowed;
  }

  async audit(limit?: number) {
    return await this.state.listAudit(limit);
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
    this.usage = await this.readUsage();
    // A suspended tenant is meant to have a stopped Gateway. Refusing to scan is
    // the second line of defence when the control plane failed to stop this one.
    if (this.config.entitlements.status === "suspended") {
      this.logger.warn(
        `AgentBox skipped synchronization: plan ${this.config.entitlements.planId} is suspended.`,
      );
      this.lastSyncCompletedAt = new Date().toISOString();
      return this.status();
    }
    this.backendStatus = await this.probeBackend();
    if (this.backendStatus.state === "error") {
      for (const status of this.sourceStatuses) {
        status.state = "error";
        status.error = this.backendStatus.error;
      }
      this.lastSyncCompletedAt = new Date().toISOString();
      return this.status();
    }
    const budget: AgentBoxQuotaBudget = {
      documents: this.config.entitlements.quotas.maxDocuments - this.usage.documents,
      bytes: this.config.entitlements.quotas.maxStorageBytes - this.usage.storage.bytes,
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
    this.usage = await this.readUsage();
    const status = this.status();
    await this.state.appendAudit({
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
    const cursor = await this.state.cursorForSource(sourceId);
    const scan = await adapter.scan(cursor);
    const previous = await this.state.documentsForSource(sourceId);
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
      await this.client.delete([entry.documentId]);
      await this.state.deleteDocument(key);
      previousByKey.delete(key);
      budget.documents += 1;
      budget.bytes += entry.sizeBytes ?? 0;
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
      const replacedBytes = existing ? (existing.sizeBytes ?? 0) : 0;
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
      if (existing) {
        await this.client.delete([existing.documentId]);
      }
      const documentId = await this.client.upload({
        filename: document.name,
        mimeType: document.mimeType,
        bytes,
        metadata: {
          tenant_id: this.config.tenantId,
          source_id: sourceId,
          source_key: document.key,
          modified_at_ms: document.modifiedAtMs,
          ...(document.sourceUrl ? { source_url: document.sourceUrl } : {}),
        },
      });
      const next: AgentBoxDocumentState = {
        kind: "document",
        sourceId,
        sourceKey: document.key,
        fingerprint: document.fingerprint,
        documentId,
        name: document.name,
        sourceUrl: document.sourceUrl,
        sizeBytes: bytes.byteLength,
      };
      await this.state.putDocument(next);
      budget.documents += replacedDocuments - 1;
      budget.bytes += replacedBytes - bytes.byteLength;
      status.uploaded += 1;
    }
    if (scan.cursor) {
      await this.state.putCursor(sourceId, scan.cursor);
    }
    status.indexed = (await this.state.documentsForSource(sourceId)).length;
    this.logger.info(
      `AgentBox source ${sourceId}: ${status.uploaded} uploaded, ${status.deleted} deleted, ${status.skipped} unchanged.`,
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

  private async readUsage(): Promise<AgentBoxSubscriptionStatus["usage"]> {
    const totals = await this.state.indexTotals();
    const unmeasuredDocuments = totals.documents - totals.measuredDocuments;
    return {
      documents: totals.documents,
      storage:
        unmeasuredDocuments > 0
          ? { kind: "partial", bytes: totals.bytes, unmeasuredDocuments }
          : { kind: "measured", bytes: totals.bytes },
    };
  }

  private async probeBackend(): Promise<AgentBoxBackendStatus> {
    if (!isTenantScopedDataset(this.config.tenantId, this.config.backend.datasetId)) {
      return {
        state: "error",
        error: `RAGFlow dataset ${this.config.backend.datasetId} is not scoped to tenant ${this.config.tenantId}.`,
      };
    }
    const inspect = this.client.inspect;
    if (!inspect) {
      return { state: "ready" };
    }
    try {
      await inspect.call(this.client);
      return { state: "ready" };
    } catch (error) {
      return {
        state: "error",
        error: `RAGFlow is unreachable: ${this.errorMessage(error)}`,
      };
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
