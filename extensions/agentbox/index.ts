import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "./api.js";
import { agentBoxConfigSchema, resolveAgentBoxConfig } from "./src/config.js";
import { AgentBoxService } from "./src/service.js";
import { createAgentBoxStateStore } from "./src/state.js";
import { createAgentBoxSearchTool, createAgentBoxSyncTool } from "./src/tools.js";

export default definePluginEntry({
  id: "agentbox",
  name: "AlpenData AgentBox",
  description: "Secure synchronization and search for company documents",
  configSchema: agentBoxConfigSchema,
  register(api) {
    const config = resolveAgentBoxConfig(api.pluginConfig);
    const state = createAgentBoxStateStore(api.runtime.state.openKeyedStore);
    let service: AgentBoxService | null = null;

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "documents",
      label: "Company documents",
      description: "Document connections, synchronization health, and onboarding progress.",
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
      if (config.backend.baseUrl.startsWith("http://")) {
        findings.push({
          checkId: "agentbox.backend.http",
          severity: "warn",
          title: "AgentBox RAGFlow transport is not encrypted",
          detail:
            "The configured RAGFlow backend uses HTTP. This is acceptable only inside the tenant's isolated private network.",
          remediation:
            "Use HTTPS, or verify that the backend is reachable only on an isolated tenant network.",
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
      (run: (params: unknown) => unknown) =>
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          respond(true, await run(params));
        } catch (error) {
          const message = formatErrorMessage(error);
          respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
      };

    api.registerService({
      id: "agentbox",
      start: (context) => {
        service = new AgentBoxService(config, state, context.logger);
        service.start();
      },
      stop: () => {
        service?.stop();
        service = null;
      },
    });

    api.registerGatewayMethod(
      "agentbox.status",
      handle(() => requireService().status()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "agentbox.sync",
      handle(() => requireService().runOnce()),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "agentbox.search",
      handle((params) => {
        const query = (params as { query?: unknown } | undefined)?.query;
        const limit = (params as { limit?: unknown } | undefined)?.limit;
        if (typeof query !== "string" || !query.trim()) {
          throw new Error("query must be a non-empty string.");
        }
        return requireService().search(
          query,
          typeof limit === "number" && Number.isInteger(limit) ? limit : undefined,
        );
      }),
      { scope: "operator.read" },
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
