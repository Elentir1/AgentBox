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

/** Retired AgentBox source credentials that doctor should report. */
export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "agentbox", "config", "sources"],
    message:
      "AgentBox Microsoft 365 and Google Drive sources no longer accept a disposable accessTokenEnv. Configure Entra client-credentials (entraTenantIdEnv, clientIdEnv, clientSecretEnv) or a Google refresh token (clientIdEnv, clientSecretEnv, refreshTokenEnv) in the tenant secret store. openclaw doctor --fix cannot invent those credentials.",
    match: hasRetiredAccessToken,
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
