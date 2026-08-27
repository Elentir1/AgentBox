import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type AgentBoxUiSource = {
  id: string;
  type: "google-drive" | "local" | "microsoft-365" | "webdav";
  state: "idle" | "syncing" | "ready" | "error";
  indexed: number;
  uploaded: number;
  deleted: number;
  skipped: number;
  lastSyncAt?: string;
  error?: string;
};

export type AgentBoxUiStatus = {
  tenantId: string;
  running: boolean;
  syncInProgress: boolean;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  sources: AgentBoxUiSource[];
};

export type AgentBoxUiState = {
  status: AgentBoxUiStatus | null;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
  pollClient: GatewayBrowserClient | null;
  requestUpdate: (() => void) | null;
};

const POLL_INTERVAL_MS = 15_000;
const states = new WeakMap<object, AgentBoxUiState>();

export function getAgentBoxState(host: object): AgentBoxUiState {
  let state = states.get(host);
  if (!state) {
    state = {
      status: null,
      loading: false,
      syncing: false,
      error: null,
      pollTimer: null,
      pollClient: null,
      requestUpdate: null,
    };
    states.set(host, state);
  }
  return state;
}

async function refresh(
  host: object,
  client: GatewayBrowserClient,
  options: { quiet?: boolean } = {},
): Promise<void> {
  const state = getAgentBoxState(host);
  if (!options.quiet) {
    state.loading = true;
    state.requestUpdate?.();
  }
  try {
    state.status = await client.request<AgentBoxUiStatus>("agentbox.status", {});
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    state.requestUpdate?.();
  }
}

export function ensureAgentBoxPolling(params: {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestUpdate?: () => void;
}): AgentBoxUiState {
  const state = getAgentBoxState(params.host);
  state.requestUpdate = params.requestUpdate ?? null;
  if (!params.connected || !params.client) {
    if (state.pollTimer) {
      globalThis.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollClient = null;
    return state;
  }
  if (state.pollClient !== params.client) {
    if (state.pollTimer) {
      globalThis.clearInterval(state.pollTimer);
    }
    state.pollClient = params.client;
    void refresh(params.host, params.client);
    state.pollTimer = globalThis.setInterval(
      () => void refresh(params.host, params.client!, { quiet: true }),
      POLL_INTERVAL_MS,
    );
  }
  return state;
}

export async function syncAgentBox(host: object, client: GatewayBrowserClient): Promise<void> {
  const state = getAgentBoxState(host);
  state.syncing = true;
  state.error = null;
  state.requestUpdate?.();
  try {
    state.status = await client.request<AgentBoxUiStatus>("agentbox.sync", {});
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.syncing = false;
    state.requestUpdate?.();
  }
}

export function stopAgentBoxPolling(host: object): void {
  const state = states.get(host);
  if (state?.pollTimer) {
    globalThis.clearInterval(state.pollTimer);
  }
  states.delete(host);
}
