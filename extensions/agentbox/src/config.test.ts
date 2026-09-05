import { afterEach, describe, expect, it, vi } from "vitest";
import { isTenantScopedDataset, requireConfiguredSecret, resolveAgentBoxConfig } from "./config.js";

afterEach(() => {
  delete process.env.AGENTBOX_TEST_SECRET;
});

const microsoftSource = {
  id: "microsoft",
  type: "microsoft-365" as const,
  driveId: "drive-id",
  entraTenantIdEnv: "AGENTBOX_MS_TENANT_ID",
  clientIdEnv: "AGENTBOX_MS_CLIENT_ID",
  clientSecretEnv: "AGENTBOX_MS_CLIENT_SECRET",
};

const googleSource = {
  id: "google",
  type: "google-drive" as const,
  clientIdEnv: "AGENTBOX_GOOGLE_CLIENT_ID",
  clientSecretEnv: "AGENTBOX_GOOGLE_CLIENT_SECRET",
  refreshTokenEnv: "AGENTBOX_GOOGLE_REFRESH_TOKEN",
};

describe("AgentBox config", () => {
  it("accepts one isolated tenant with renewable source credentials", () => {
    const config = resolveAgentBoxConfig({
      tenantId: "acme",
      entitlements: {
        planId: "business",
        status: "active",
        quotas: {
          maxSources: 4,
          maxDocuments: 25_000,
          maxStorageBytes: 53_687_091_200,
          minSyncIntervalMinutes: 15,
        },
      },
      backend: {
        baseUrl: "http://ragflow.internal:9380",
        datasetId: "acme",
        apiKeyEnv: "RAGFLOW_API_KEY",
        allowPrivateNetwork: true,
      },
      sources: [
        { id: "local", type: "local", root: "/documents" },
        googleSource,
        microsoftSource,
        {
          id: "webdav",
          type: "webdav",
          baseUrl: "https://cloud.example.test",
          usernameEnv: "WEBDAV_USERNAME",
          passwordEnv: "WEBDAV_PASSWORD",
        },
      ],
    });

    expect(config.sync.intervalMinutes).toBe(15);
    expect(config.sources.map((source) => source.type)).toEqual([
      "local",
      "google-drive",
      "microsoft-365",
      "webdav",
    ]);
    expect(isTenantScopedDataset("acme", "acme-internal")).toBe(true);
    expect(isTenantScopedDataset("acme", "other")).toBe(false);
  });

  it("rejects a corpus or cadence the plan does not cover", () => {
    const base = {
      tenantId: "acme",
      entitlements: {
        planId: "starter",
        status: "active" as const,
        quotas: {
          maxSources: 1,
          maxDocuments: 5_000,
          maxStorageBytes: 10_737_418_240,
          minSyncIntervalMinutes: 60,
        },
      },
      backend: {
        baseUrl: "https://ragflow.example.test",
        datasetId: "acme",
        apiKeyEnv: "RAGFLOW_API_KEY",
      },
    };

    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        sources: [{ id: "local", type: "local", root: "/documents" }, googleSource],
      }),
    ).toThrow("allows 1 document sources");

    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        sync: { intervalMinutes: 15, maxFileBytes: 1024 },
        sources: [{ id: "local", type: "local", root: "/documents" }],
      }),
    ).toThrow("60 minutes at the fastest");

    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        entitlements: {
          ...base.entitlements,
          quotas: { ...base.entitlements.quotas, maxDocuments: 250_000 },
        },
        sources: [{ id: "local", type: "local", root: "/documents" }],
      }),
    ).toThrow();

    const accepted = resolveAgentBoxConfig({
      ...base,
      sync: { intervalMinutes: 60, maxFileBytes: 1024 },
      sources: [{ id: "local", type: "local", root: "/documents" }],
    });
    expect(accepted.entitlements.planId).toBe("starter");
  });

  it("rejects disposable access tokens, duplicate sources, and insecure transports", () => {
    const base = {
      tenantId: "acme",
      entitlements: {
        planId: "business",
        status: "active",
        quotas: {
          maxSources: 4,
          maxDocuments: 25_000,
          maxStorageBytes: 53_687_091_200,
          minSyncIntervalMinutes: 15,
        },
      },
      backend: {
        baseUrl: "https://ragflow.example.test",
        datasetId: "acme",
        apiKeyEnv: "RAGFLOW_API_KEY",
      },
    };
    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        sources: [
          { id: "docs", type: "local", root: "/one" },
          { id: "docs", type: "local", root: "/two" },
        ],
      }),
    ).toThrow("Source ids");
    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        sources: [
          {
            id: "microsoft",
            type: "microsoft-365",
            driveId: "drive-id",
            accessTokenEnv: "MICROSOFT_ACCESS_TOKEN",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        sources: [
          {
            id: "dav",
            type: "webdav",
            baseUrl: "http://cloud.example.test",
            usernameEnv: "WEBDAV_USERNAME",
            passwordEnv: "WEBDAV_PASSWORD",
          },
        ],
      }),
    ).toThrow("WebDAV requires HTTPS");
    expect(() =>
      resolveAgentBoxConfig({
        ...base,
        backend: {
          ...base.backend,
          baseUrl: "http://ragflow.internal:9380",
        },
        sources: [{ id: "local", type: "local", root: "/documents" }],
      }),
    ).toThrow("allowPrivateNetwork");
  });

  it("loads secrets only from the named process environment", () => {
    process.env.AGENTBOX_TEST_SECRET = "secret";
    expect(requireConfiguredSecret("AGENTBOX_TEST_SECRET")).toBe("secret");
    expect(() => requireConfiguredSecret("MISSING_AGENTBOX_SECRET")).toThrow(
      "MISSING_AGENTBOX_SECRET",
    );
  });
});
