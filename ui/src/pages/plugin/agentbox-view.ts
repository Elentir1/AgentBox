import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  ensureAgentBoxPolling,
  syncAgentBox,
  type AgentBoxUiSource,
} from "./agentbox-controller.ts";

const SOURCE_LABELS: Record<AgentBoxUiSource["type"], string> = {
  "google-drive": "Google Drive",
  local: "Folders and PDF files",
  "microsoft-365": "Microsoft 365",
  webdav: "Nextcloud / kDrive",
};

function statusLabel(source: AgentBoxUiSource): string {
  switch (source.state) {
    case "error":
      return source.error || "Connection needs attention";
    case "syncing":
      return "Synchronizing";
    case "ready":
      return `${source.indexed} documents available`;
    case "idle":
      return "Waiting for first synchronization";
  }
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
  const allSourcesReady = sources.length > 0 && sources.every((source) => source.state === "ready");
  const steps = [
    { label: "Dedicated AgentBox is running", complete: status?.running === true },
    { label: "Document sources are connected", complete: sources.length > 0 },
    { label: "Every source synchronized successfully", complete: allSourcesReady },
    { label: "Company documents are searchable", complete: totalDocuments > 0 },
  ];

  return html`
    <section class="page">
      <div class="page-header">
        <div>
          <div class="eyebrow">AlpenData AgentBox</div>
          <h1>Company knowledge</h1>
          <p class="muted">
            Connect, synchronize, and verify the sources available to your employees.
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

      ${state.error ? html`<div class="callout danger" role="alert">${state.error}</div>` : nothing}

      <div class="card">
        <div class="card-title">Activation progress</div>
        <div class="stack">
          ${steps.map(
            (step) => html`
              <div class="row">
                <span aria-hidden="true">${step.complete ? "✓" : "○"}</span>
                <span>${step.label}</span>
              </div>
            `,
          )}
        </div>
      </div>

      <div class="grid grid-2">
        ${sources.map(
          (source) => html`
            <article class="card">
              <div class="card-title">${SOURCE_LABELS[source.type]}</div>
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

      ${sources.length === 0 && !state.loading
        ? html`
            <div class="card">
              <div class="card-title">No document source configured</div>
              <p class="muted">
                Ask your AlpenData administrator to connect Microsoft 365, Google Drive,
                Nextcloud/kDrive, or a secure document folder.
              </p>
            </div>
          `
        : nothing}
    </section>
  `;
}
