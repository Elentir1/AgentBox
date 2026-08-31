import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
      publicOrigin: "https://assistant.acme.test",
      identity: {
        mode: "trusted-proxy",
        trustedProxies: ["172.20.0.10"],
        userHeader: "x-forwarded-user",
      },
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
            entraTenantIdEnv: "AGENTBOX_MS_TENANT_ID",
            clientIdEnv: "AGENTBOX_MS_CLIENT_ID",
            clientSecretEnv: "AGENTBOX_MS_CLIENT_SECRET",
          },
          {
            id: "google",
            type: "google-drive",
            clientIdEnv: "AGENTBOX_GOOGLE_CLIENT_ID",
            clientSecretEnv: "AGENTBOX_GOOGLE_CLIENT_SECRET",
            refreshTokenEnv: "AGENTBOX_GOOGLE_REFRESH_TOKEN",
          },
          {
            id: "webdav",
            type: "webdav",
            baseUrl: "https://123456.connect.kdrive.infomaniak.com",
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
  it("renders an isolated deployment and lists secret names without values", () => {
    const { tenant, files } = renderTenantArtifacts(createManifest());
    const batch = JSON.parse(files["openclaw.batch.json"]) as Array<{
      path: string;
      value: unknown;
    }>;
    const plugin = batch.find((entry) => entry.path === "plugins.entries.agentbox");
    const controlUi = batch.find((entry) => entry.path === "gateway.controlUi")?.value as {
      shellProfile?: string;
      product?: { docsUrl?: string; privacyUrl?: string; supportUrl?: string };
    };

    expect(tenant.identity.mode).toBe("trusted-proxy");
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
    expect(files["runtime.env.example"]).toContain("AGENTBOX_MS_CLIENT_SECRET=");
    expect(files["runtime.env.example"]).toContain("AGENTBOX_GOOGLE_REFRESH_TOKEN=");
    expect(files["runtime.env.example"]).not.toMatch(/=.+/u);
    expect(controlUi.shellProfile).toBe("auto");
    expect(controlUi.product?.supportUrl).toBe("https://www.alpendata.ch/contact");
    expect(controlUi.product?.docsUrl).toBeUndefined();
    expect(controlUi.product?.privacyUrl).toBeUndefined();
    expect(files["workspace/AGENTS.md"]).toContain("agentbox_search");
    expect(files["workspace/AGENTS.md"]).toContain("Do not invent");
    expect(batch.find((entry) => entry.path === "ui.seamColor")?.value).toBe("#dc2626");
  });

  it("ships an operator template without product placeholders presented as live", () => {
    const template = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../deploy/agentbox/examples/tenant.template.yaml",
      ),
      "utf8",
    );
    expect(template).toContain("trusted-proxy");
    expect(template).toContain("<agentbox-image>");
    expect(template).toContain("https://<id>.connect.kdrive.infomaniak.com");
    expect(template).not.toContain("example.com");
    expect(template).not.toContain("ghcr.io/alpendata/agentbox:2026.8");
    expect(template).not.toContain("accessTokenEnv");
  });

  it("rejects shared, unsafe, or placeholder-style deployment inputs", () => {
    const missingIdentity = createManifest() as { spec: Record<string, unknown> };
    delete missingIdentity.spec.identity;
    expect(() => normalizeTenantManifest(missingIdentity)).toThrow("spec.identity");

    const missingMode = createManifest();
    const identityWithoutMode = { ...missingMode.spec.identity } as {
      mode?: string;
      trustedProxies: string[];
      userHeader: string;
    };
    delete identityWithoutMode.mode;
    missingMode.spec.identity = identityWithoutMode as typeof missingMode.spec.identity;
    expect(() => normalizeTenantManifest(missingMode)).toThrow("identity.mode");

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

    const retiredToken = createManifest();
    retiredToken.spec.documents.sources[0] = {
      id: "microsoft",
      type: "microsoft-365",
      driveId: "drive-id",
      accessTokenEnv: "MICROSOFT_TOKEN",
    } as never;
    expect(() => normalizeTenantManifest(retiredToken)).toThrow("entraTenantIdEnv");

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
