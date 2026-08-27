import { describe, expect, it } from "vitest";
import {
  normalizeTenantManifest,
  renderTenantArtifacts,
} from "../../deploy/agentbox/render-tenant.mjs";

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
    expect(() => normalizeTenantManifest(rootManifest)).toThrow("tenant id");

    const sharedRoot = createManifest();
    sharedRoot.spec.hostRoot = "/var/lib/agentbox/shared";
    expect(() => normalizeTenantManifest(sharedRoot)).toThrow("tenant id");

    const foreignDataset = createManifest();
    foreignDataset.spec.documents.backend.datasetId = "other-company";
    expect(() => normalizeTenantManifest(foreignDataset)).toThrow("tenant id");

    const insecureWebDav = createManifest();
    insecureWebDav.spec.documents.sources[2].baseUrl = "http://cloud.example.test";
    expect(() => normalizeTenantManifest(insecureWebDav)).toThrow("HTTPS");

    const proxyWithoutAllowlist = createManifest();
    proxyWithoutAllowlist.spec.identity = {
      mode: "trusted-proxy",
      userHeader: "x-forwarded-user",
    };
    expect(() => normalizeTenantManifest(proxyWithoutAllowlist)).toThrow("trustedProxies");
  });

  it("keeps two customer manifests on disjoint storage identities", () => {
    const acme = renderTenantArtifacts(createManifest());
    const second = createManifest();
    second.metadata.id = "contoso";
    second.metadata.displayName = "Contoso SA";
    second.spec.hostRoot = "/var/lib/agentbox/contoso";
    second.spec.documents.backend.datasetId = "contoso-internal";
    const contoso = renderTenantArtifacts(second);

    expect(acme.files["docker-compose.override.yml"]).toContain("name: agentbox-acme");
    expect(contoso.files["docker-compose.override.yml"]).toContain("name: agentbox-contoso");
    expect(acme.tenant.hostRoot).not.toBe(contoso.tenant.hostRoot);
    expect(acme.tenant.documents.backend.datasetId).not.toBe(
      contoso.tenant.documents.backend.datasetId,
    );
  });
});
