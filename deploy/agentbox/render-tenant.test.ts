import { describe, expect, it } from "vitest";
import { normalizeTenantManifest, renderTenantArtifacts } from "./render-tenant.mjs";

function createManifest() {
  return {
    apiVersion: "agentbox.alpendata.ch/v1",
    kind: "Tenant",
    metadata: { id: "acme", displayName: "Acme SA" },
    spec: {
      image: "agentbox:test",
      hostRoot: "/var/lib/agentbox/acme",
      publicOrigin: "https://assistant.acme.example",
      provider: { model: "openai/gpt-5.5", apiKeyEnv: "OPENAI_API_KEY" },
      documents: {
        backend: {
          baseUrl: "http://ragflow.internal:9380",
          datasetId: "acme",
          apiKeyEnv: "RAGFLOW_API_KEY",
          allowPrivateNetwork: true,
        },
        sources: [
          {
            id: "microsoft",
            type: "microsoft-365",
            driveId: "drive-id",
            accessTokenEnv: "MICROSOFT_TOKEN",
          },
          {
            id: "google",
            type: "google-drive",
            accessTokenEnv: "GOOGLE_TOKEN",
          },
          {
            id: "webdav",
            type: "webdav",
            baseUrl: "https://cloud.example.test",
            usernameEnv: "WEBDAV_USER",
            passwordEnv: "WEBDAV_PASSWORD",
          },
          { id: "local", type: "local", root: "/srv/acme/documents" },
        ],
      },
    },
  };
}

describe("AgentBox tenant renderer", () => {
  it("renders an isolated deployment and all document sources", () => {
    const { tenant, files } = renderTenantArtifacts(createManifest());
    const batch = JSON.parse(files["openclaw.batch.json"]) as Array<{
      path: string;
      value: unknown;
    }>;
    const plugin = batch.find((entry) => entry.path === "plugins.entries.agentbox");

    expect(tenant.documents.sources.map((source) => source.type)).toEqual([
      "microsoft-365",
      "google-drive",
      "webdav",
      "local",
    ]);
    expect(files["docker-compose.override.yml"]).toContain(
      "/srv/acme/documents:/agentbox/sources/local:ro",
    );
    expect(plugin?.value).toMatchObject({
      enabled: true,
      config: {
        tenantId: "acme",
        sources: expect.arrayContaining([
          { id: "local", type: "local", root: "/agentbox/sources/local" },
        ]),
      },
    });
    expect(files["runtime.env.example"]).toContain("MICROSOFT_TOKEN=");
  });

  it("rejects shared or unsafe deployment inputs", () => {
    const rootManifest = createManifest();
    rootManifest.spec.hostRoot = "/";
    expect(() => normalizeTenantManifest(rootManifest)).toThrow("tenant-specific");

    const insecureWebDav = createManifest();
    insecureWebDav.spec.documents.sources[2].baseUrl = "http://cloud.example.test";
    expect(() => normalizeTenantManifest(insecureWebDav)).toThrow("HTTPS");
  });
});
