import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "./api.js";
import { agentBoxConfigSchema, resolveAgentBoxConfig } from "./src/config.js";
import { openAgentBoxIndexStore, type AgentBoxIndexStore } from "./src/index-store.js";
import { createAgentBoxEmbedder } from "./src/indexer.js";
import { AgentBoxService } from "./src/service.js";
import { createAgentBoxAuditStore } from "./src/state.js";
import { createAgentBoxSearchTool, createAgentBoxSyncTool } from "./src/tools.js";

function resolveSearchActor(client: GatewayRequestHandlerOptions["client"]): string {
  const display = client?.connect?.client?.displayName?.trim();
  const id = client?.connect?.client?.id?.trim();
  const ip = client?.clientIp?.trim();
  return `${display || id || "unknown-client"}@${ip || "unknown-ip"}`;
}

export default definePluginEntry({
  id: "agentbox",
  name: "AlpenData AgentBox",
  description: "Secure synchronization and search for company documents",
  configSchema: agentBoxConfigSchema,
  register(api) {
    const config = resolveAgentBoxConfig(api.pluginConfig);
    const audit = createAgentBoxAuditStore(api.runtime.state.openKeyedStore);
    let service: AgentBoxService | null = null;
    let index: AgentBoxIndexStore | null = null;

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "documents",
      label: "Company documents",
      description: "Document source health, index status, and indexed company files.",
      icon: "fileText",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    api.registerSecurityAuditCollector(() => {
      const findings: Array<{
        checkId: string;
        severity: "info" | "warn" | "critical";
        title: string;
        detail: string;
        remediation: string;
      }> = [];
      if (config.index.embedding.baseUrl.startsWith("http://")) {
        findings.push({
          checkId: "agentbox.embedding.http",
          severity: "warn",
          title: "AgentBox embedding transport is not encrypted",
          detail:
            "The configured embedding endpoint uses HTTP. Document text is sent to it, so this is acceptable only on the tenant's isolated private network.",
          remediation:
            "Use HTTPS, or verify that the endpoint is reachable only on an isolated tenant network.",
        });
      }
      if (config.entitlements.status === "suspended") {
        findings.push({
          checkId: "agentbox.subscription.suspended",
          severity: "critical",
          title: "AgentBox is running with a suspended subscription",
          detail: `Plan ${config.entitlements.planId} is suspended, but this Gateway is running. Suspension is enforced by stopping the deployment; a running suspended tenant means the control plane did not complete that step.`,
          remediation:
            "Stop the tenant Compose project, or reinstate the subscription and re-render the tenant manifest.",
        });
      }
      for (const source of config.sources) {
        if (source.type === "webdav" && source.allowPrivateNetwork) {
          findings.push({
            checkId: `agentbox.webdav.private.${source.id}`,
            severity: "info",
            title: "AgentBox WebDAV private-network access is enabled",
            detail: `Source ${source.id} may connect to private addresses within its configured HTTPS origin.`,
            remediation: "Keep the WebDAV origin tenant-owned and restrict egress to that host.",
          });
        }
      }
      return findings;
    });

    const requireService = () => {
      if (!service) {
        throw new Error("AgentBox document service is not running.");
      }
      return service;
    };
    const handle =
      (run: (options: GatewayRequestHandlerOptions) => unknown) =>
      async (options: GatewayRequestHandlerOptions) => {
        try {
          options.respond(true, await run(options));
        } catch (error) {
          const message = formatErrorMessage(error);
          options.respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
      };

    api.registerService({
      id: "agentbox",
      start: async (context) => {
        // The runtime hands out a DeepReadonly snapshot; embedding and extraction
        // only read it. Same narrowing every other bundled plugin uses.
        const openClawConfig = api.runtime.config.current() as OpenClawConfig;
        const embedder = await createAgentBoxEmbedder({
          config: config.index.embedding,
          openClawConfig,
        });
        // The index is keyed to the embedding identity: vectors from a different
        // model or endpoint are not comparable, so the store rebuilds instead.
        index = openAgentBoxIndexStore({ embeddingIdentity: embedder.identity });
        service = new AgentBoxService(config, index, embedder, audit, context.logger);
        service.start();
      },
      stop: () => {
        service?.stop();
        service = null;
        index?.close();
        index = null;
      },
    });

    api.registerGatewayMethod(
      "agentbox.status",
      handle(() => requireService().refreshStatus()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "agentbox.sync",
      handle(() => requireService().runOnce()),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "agentbox.search",
      handle(({ params, client }) => {
        const query = params.query;
        const limit = params.limit;
        if (typeof query !== "string" || !query.trim()) {
          throw new Error("query must be a non-empty string.");
        }
        return requireService().search(
          query,
          typeof limit === "number" && Number.isInteger(limit) ? limit : undefined,
          resolveSearchActor(client),
        );
      }),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "agentbox.audit",
      handle(({ params }) => {
        const limit = params.limit;
        return requireService().auditTrail(
          typeof limit === "number" && Number.isInteger(limit) ? limit : undefined,
        );
      }),
      { scope: "operator.admin" },
    );

    api.registerTool(
      createAgentBoxSearchTool(() => service),
      { name: "agentbox_search" },
    );
    api.registerTool(
      createAgentBoxSyncTool(() => service),
      { name: "agentbox_sync" },
    );
  },
});
