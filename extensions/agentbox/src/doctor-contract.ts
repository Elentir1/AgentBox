import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasRetiredAccessToken(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((source) => {
    const record = asRecord(source);
    return Boolean(record && typeof record.accessTokenEnv === "string");
  });
}

function isMissingEntitlements(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && record.entitlements === undefined);
}

/** Retired AgentBox source credentials that doctor should report. */
export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "agentbox", "config", "sources"],
    message:
      "AgentBox Microsoft 365 and Google Drive sources no longer accept a disposable accessTokenEnv. Configure Entra client-credentials (entraTenantIdEnv, clientIdEnv, clientSecretEnv) or a Google refresh token (clientIdEnv, clientSecretEnv, refreshTokenEnv) in the tenant secret store. openclaw doctor --fix cannot invent those credentials.",
    match: hasRetiredAccessToken,
  },
  {
    path: ["plugins", "entries", "agentbox", "config"],
    message:
      "AgentBox requires a subscription entitlements block. Re-render the tenant manifest with spec.subscription (deploy/agentbox/render-tenant.mjs) and reapply openclaw.batch.json. openclaw doctor --fix cannot invent the plan the customer bought.",
    match: isMissingEntitlements,
  },
];

/**
 * Doctor cannot mint Entra or Google client credentials. Leave the config
 * unchanged so the operator replaces accessTokenEnv with the canonical fields.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return { config: cfg, changes: [] };
}
