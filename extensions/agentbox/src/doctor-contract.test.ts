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

  it("reports a tenant configured without a subscription plan", () => {
    const rule = legacyConfigRules.find(
      (entry) => entry.path.join(".") === "plugins.entries.agentbox.config",
    );

    expect(rule?.match?.({ tenantId: "acme", sources: [] })).toBe(true);
    expect(
      rule?.match?.({
        tenantId: "acme",
        entitlements: { planId: "business", status: "active" },
        sources: [],
      }),
    ).toBe(false);
    expect(rule?.message).toContain("cannot invent the plan");
  });
});
