import { afterEach, describe, expect, it } from "vitest";
import { requireConfiguredSecret, resolveAgentBoxConfig } from "./config.js";

afterEach(() => {
  delete process.env.AGENTBOX_TEST_SECRET;
});

describe("AgentBox config", () => {
  it("accepts one isolated tenant with all source families", () => {
    const config = resolveAgentBoxConfig({
      tenantId: "acme",
      backend: {
        baseUrl: "http://ragflow.internal:9380",
        datasetId: "acme",
        apiKeyEnv: "RAGFLOW_API_KEY",
        allowPrivateNetwork: true,
      },
      sources: [
        { id: "local", type: "local", root: "/documents" },
        {
          id: "google",
          type: "google-drive",
          accessTokenEnv: "GOOGLE_ACCESS_TOKEN",
        },
        {
          id: "microsoft",
          type: "microsoft-365",
          driveId: "drive-id",
          accessTokenEnv: "MICROSOFT_ACCESS_TOKEN",
        },
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
  });

  it("rejects duplicate sources and insecure WebDAV", () => {
    const base = {
      tenantId: "acme",
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
            id: "dav",
            type: "webdav",
            baseUrl: "http://cloud.example.test",
            usernameEnv: "WEBDAV_USERNAME",
            passwordEnv: "WEBDAV_PASSWORD",
          },
        ],
      }),
    ).toThrow("WebDAV requires HTTPS");
  });

  it("loads secrets only from the named process environment", () => {
    process.env.AGENTBOX_TEST_SECRET = "secret";
    expect(requireConfiguredSecret("AGENTBOX_TEST_SECRET")).toBe("secret");
    expect(() => requireConfiguredSecret("MISSING_AGENTBOX_SECRET")).toThrow(
      "MISSING_AGENTBOX_SECRET",
    );
  });
});
