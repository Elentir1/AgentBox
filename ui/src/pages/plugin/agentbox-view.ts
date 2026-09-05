import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  ensureAgentBoxPolling,
  syncAgentBox,
  type AgentBoxUiSource,
  type AgentBoxUiStatus,
  type AgentBoxUiSubscription,
} from "./agentbox-controller.ts";

const SOURCE_LABELS: Record<AgentBoxUiSource["type"], string> = {
  "google-drive": "Google Drive",
  local: "Local folder",
  "microsoft-365": "Microsoft 365",
  webdav: "Infomaniak kDrive",
};

function statusLabel(source: AgentBoxUiSource): string {
  switch (source.state) {
    case "error":
      return source.error || "Connection needs attention";
    case "syncing":
      return "Synchronizing";
    case "ready":
      return source.indexed === 0
        ? "Connected, but no documents are indexed yet"
        : `${source.indexed} documents available`;
    case "idle":
      return "Waiting for first synchronization";
  }
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  if (gigabytes >= 1) {
    return `${gigabytes.toFixed(1)} GB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function storageLabel(subscription: AgentBoxUiSubscription): string {
  return t("agentbox.plan.storage", {
    used: formatBytes(subscription.usage.bytes),
    total: formatBytes(subscription.quotas.maxStorageBytes),
  });
}

/**
 * Only a plan that needs customer action is worth interrupting the page for. The
 * Record keeps the table exhaustive, so a new subscription state cannot ship
 * silently without deciding what the customer is told.
 */
const SUBSCRIPTION_NOTICE_KEYS: Record<AgentBoxUiSubscription["state"], string | null> = {
  active: null,
  grace: "agentbox.subscription.grace",
  suspended: "agentbox.subscription.suspended",
};

function subscriptionNotice(subscription: AgentBoxUiSubscription): string | null {
  const key = SUBSCRIPTION_NOTICE_KEYS[subscription.state];
  return key ? t(key) : null;
}

function indexMessage(status: AgentBoxUiStatus | null): string | null {
  if (!status) {
    return null;
  }
  if (status.index?.state === "error") {
    return status.index.error || "The document index is unavailable.";
  }
  return null;
}

export function renderAgentBox(props: {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
}) {
  const state = ensureAgentBoxPolling({
    host: props.host,
    client: props.client,
    connected: props.connected,
    requestUpdate: props.onRequestUpdate,
  });
  const status = state.status;
  const sources = status?.sources ?? [];
  const totalDocuments = sources.reduce((sum, source) => sum + source.indexed, 0);
  const sourceErrors = sources.filter((source) => source.state === "error");
  const indexError = indexMessage(status);
  const visibleError = state.error || indexError;
  const subscription = status?.subscription;
  const notice = subscription ? subscriptionNotice(subscription) : null;

  return html`
    <section class="page">
      <div class="page-header">
        <div>
          <div class="eyebrow">AlpenData AgentBox</div>
          <h1>Company knowledge</h1>
          <p class="muted">
            Microsoft 365, Google Drive, and Infomaniak kDrive files indexed for this company.
            Everyone in this AgentBox can search the same corpus.
          </p>
        </div>
        <button
          class="btn primary"
          ?disabled=${!props.client || state.syncing}
          @click=${() => props.client && void syncAgentBox(props.host, props.client)}
        >
          ${state.syncing ? "Synchronizing…" : "Synchronize now"}
        </button>
      </div>

      ${notice
        ? html`<div
            class=${subscription?.state === "suspended" ? "callout danger" : "callout warn"}
            role="alert"
          >
            ${notice}
          </div>`
        : nothing}
      ${visibleError
        ? html`<div class="callout danger" role="alert">${visibleError}</div>`
        : nothing}
      ${subscription
        ? html`
            <article class="card">
              <div class="card-title">${t("agentbox.plan.title")}</div>
              <div class="card-sub">${subscription.planId}</div>
              <p class="muted">
                ${t("agentbox.plan.summary", {
                  documents: String(subscription.usage.documents),
                  maxDocuments: String(subscription.quotas.maxDocuments),
                  storage: storageLabel(subscription),
                  sources: String(sources.length),
                  maxSources: String(subscription.quotas.maxSources),
                })}
              </p>
              <p class="muted">${t("agentbox.plan.limitNote")}</p>
            </article>
          `
        : nothing}
      ${state.loading && !status
        ? html`<div class="card"><p class="muted">Checking document sources…</p></div>`
        : nothing}
      ${sources.length === 0 && !state.loading && !visibleError
        ? html`
            <div class="card">
              <div class="card-title">No document source configured</div>
              <p class="muted">
                Ask AlpenData to connect Microsoft 365, Google Drive, or Infomaniak kDrive for this
                company. This page stays empty until a live source exists.
              </p>
            </div>
          `
        : nothing}
      ${sources.length > 0 && totalDocuments === 0 && sourceErrors.length === 0 && !indexError
        ? html`
            <div class="card">
              <div class="card-title">No documents indexed yet</div>
              <p class="muted">
                Sources are configured, but the searchable corpus is still empty. Run
                synchronization after credentials and RAGFlow are healthy.
              </p>
            </div>
          `
        : nothing}
      ${sourceErrors.length > 0
        ? html`
            <div class="card">
              <div class="card-title">Source connection failed</div>
              <p class="muted">
                Dead or expired credentials fail closed. AgentBox will not scan with a token that
                cannot be renewed.
              </p>
            </div>
          `
        : nothing}

      <div class="grid grid-2">
        ${sources.map(
          (source) => html`
            <article class="card">
              <div class="card-title">${SOURCE_LABELS[source.type] ?? source.type}</div>
              <div class="card-sub">${source.id}</div>
              <p class=${source.state === "error" ? "text-danger" : "muted"}>
                ${statusLabel(source)}
              </p>
              ${source.lastSyncAt
                ? html`<div class="muted">
                    Last sync: ${new Date(source.lastSyncAt).toLocaleString()}
                  </div>`
                : nothing}
            </article>
          `,
        )}
      </div>
    </section>
  `;
}
