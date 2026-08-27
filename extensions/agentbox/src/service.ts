import type { AgentBoxConfig } from "./config.js";
import { RagFlowClient, type AgentBoxSearchResult } from "./ragflow-client.js";
import { createSourceAdapter, type AgentBoxDocument } from "./sources.js";
import type { AgentBoxDocumentState, AgentBoxStateStore } from "./state.js";

type AgentBoxLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type AgentBoxDocumentClient = Pick<RagFlowClient, "delete" | "search" | "upload">;

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

export type AgentBoxStatus = {
  tenantId: string;
  running: boolean;
  syncInProgress: boolean;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  sources: AgentBoxSourceStatus[];
};

export class AgentBoxService {
  private readonly client: AgentBoxDocumentClient;
  private readonly sourceStatuses: AgentBoxSourceStatus[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private syncPromise: Promise<AgentBoxStatus> | undefined;
  private running = false;
  private lastSyncStartedAt: string | undefined;
  private lastSyncCompletedAt: string | undefined;
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
      sources: this.sourceStatuses.map((source) => ({ ...source })),
    };
  }

  async search(question: string, limit?: number): Promise<AgentBoxSearchResult[]> {
    return await this.client.search(question, limit);
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
        await this.syncSource(source.id, status);
        status.state = "ready";
        status.lastSyncAt = new Date().toISOString();
      } catch (error) {
        status.state = "error";
        status.error = this.errorMessage(error);
        this.logger.warn(`AgentBox source ${source.id} sync failed: ${status.error}`);
      }
    }
    this.lastSyncCompletedAt = new Date().toISOString();
    return this.status();
  }

  private async syncSource(sourceId: string, status: AgentBoxSourceStatus): Promise<void> {
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
      if (existing) {
        await this.client.delete([existing.documentId]);
      }
      const bytes = await document.read();
      if (bytes.byteLength > this.config.sync.maxFileBytes) {
        throw new Error(
          `${document.name} download exceeds the configured ${this.config.sync.maxFileBytes} byte limit.`,
        );
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
      };
      await this.state.putDocument(next);
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
