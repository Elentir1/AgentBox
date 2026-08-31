import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../doctor-contract-api.js";

describe("AgentBox doctor contract", () => {
  it("flags retired disposable access tokens and does not invent replacements", () => {
    const sources = [
      {
        id: "microsoft",
        type: "microsoft-365",
        driveId: "drive-id",
        accessTokenEnv: "MICROSOFT_ACCESS_TOKEN",
      },
    ];
    expect(legacyConfigRules[0]?.match?.(sources)).toBe(true);
    expect(
      legacyConfigRules[0]?.match?.([
        {
          id: "microsoft",
          type: "microsoft-365",
          driveId: "drive-id",
          entraTenantIdEnv: "AGENTBOX_MS_TENANT_ID",
          clientIdEnv: "AGENTBOX_MS_CLIENT_ID",
          clientSecretEnv: "AGENTBOX_MS_CLIENT_SECRET",
        },
      ]),
    ).toBe(false);

    const cfg = {
      plugins: {
        entries: {
          agentbox: {
            enabled: true,
            config: { sources },
          },
        },
      },
    };
    expect(normalizeCompatibilityConfig({ cfg: cfg as never })).toEqual({
      config: cfg,
      changes: [],
    });
  });
});
