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
      subscription: {
        planId: "business",
        status: "active",
        quotas: {
          maxSources: 4,
          maxDocuments: 25_000,
          maxStorageBytes: 53_687_091_200,
          minSyncIntervalMinutes: 15,
        },
      },
      documents: {
        embedding: {
          baseUrl: "http://embeddings.internal:8080/v1",
          model: "bge-multilingual",
          apiKeyEnv: "AGENTBOX_EMBEDDING_API_KEY",
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
        sync: { intervalMinutes: 15 },
        sources: expect.arrayContaining([
          { id: "local", type: "local", root: "/agentbox/sources/local" },
        ]),
      },
    });
    expect(files["runtime.env.example"]).toContain("AGENTBOX_EMBEDDING_API_KEY=");
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

  it("keeps the tenant Gateway off the host's public interfaces", () => {
    const { files } = renderTenantArtifacts(createManifest());

    expect(files[".env"]).toContain("OPENCLAW_PUBLISH_ADDRESS=127.0.0.1");
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
    expect(template).toContain("subscription:");
    expect(template).toContain("<plan-id>");
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

    const insecureEmbedding = createManifest();
    insecureEmbedding.spec.documents.embedding.allowPrivateNetwork = false;
    expect(() => normalizeTenantManifest(insecureEmbedding)).toThrow("allowPrivateNetwork");

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

    const missingSubscription = createManifest() as { spec: Record<string, unknown> };
    delete missingSubscription.spec.subscription;
    expect(() => normalizeTenantManifest(missingSubscription)).toThrow("spec.subscription");

    const unknownStatus = createManifest();
    unknownStatus.spec.subscription.status = "trialing" as never;
    expect(() => normalizeTenantManifest(unknownStatus)).toThrow("active, grace, or suspended");

    const oversoldCorpus = createManifest();
    oversoldCorpus.spec.subscription.quotas.maxDocuments = 250_000;
    expect(() => normalizeTenantManifest(oversoldCorpus)).toThrow("maxDocuments");

    const oversoldSources = createManifest();
    oversoldSources.spec.subscription.quotas.maxSources = 2;
    expect(() => normalizeTenantManifest(oversoldSources)).toThrow("the plan allows 2");

    const proxyWithoutAllowlist = createManifest();
    proxyWithoutAllowlist.spec.identity = {
      mode: "trusted-proxy",
      userHeader: "x-forwarded-user",
    };
    expect(() => normalizeTenantManifest(proxyWithoutAllowlist)).toThrow("trustedProxies");
  });

  it("declares a sovereign OpenAI-compatible endpoint before the model that uses it", () => {
    const manifest = createManifest();
    manifest.spec.provider = {
      model: "infomaniak/mistral24b",
      apiKeyEnv: "INFOMANIAK_API_KEY",
      baseUrl: "https://api.infomaniak.com/2/ai/12345/openai/v1",
      models: [{ id: "mistral24b", name: "Mistral 24B", contextWindow: 32_000 }],
    } as never;
    const { files } = renderTenantArtifacts(manifest);
    const batch = JSON.parse(files["openclaw.batch.json"]) as Array<{
      path: string;
      value: unknown;
    }>;
    const providerIndex = batch.findIndex((entry) => entry.path === "models.providers.infomaniak");
    const modelIndex = batch.findIndex((entry) => entry.path === "agents.defaults.model");

    expect(providerIndex).toBeGreaterThanOrEqual(0);
    expect(providerIndex).toBeLessThan(modelIndex);
    expect(batch[providerIndex]?.value).toEqual({
      baseUrl: "https://api.infomaniak.com/2/ai/12345/openai/v1",
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "INFOMANIAK_API_KEY" },
      models: [{ id: "mistral24b", name: "Mistral 24B", contextWindow: 32_000 }],
    });
    expect(batch[modelIndex]?.value).toEqual({ primary: "infomaniak/mistral24b" });
    expect(files["runtime.env.example"]).toContain("INFOMANIAK_API_KEY=");
    expect(files["runtime.env.example"]).not.toMatch(/[=].+/u);
  });

  it("keeps hosted providers free of a synthetic catalog entry", () => {
    const { files } = renderTenantArtifacts(createManifest());
    const batch = JSON.parse(files["openclaw.batch.json"]) as Array<{ path: string }>;

    expect(batch.some((entry) => entry.path.startsWith("models.providers."))).toBe(false);
  });

  it("rejects an endpoint manifest that cannot resolve its own model", () => {
    const missingBaseUrl = createManifest();
    missingBaseUrl.spec.provider = {
      model: "infomaniak/mistral24b",
      apiKeyEnv: "INFOMANIAK_API_KEY",
      api: "openai-responses",
    } as never;
    expect(() => normalizeTenantManifest(missingBaseUrl)).toThrow("require spec.provider.baseUrl");

    const unqualifiedModel = createManifest();
    unqualifiedModel.spec.provider = {
      model: "mistral24b",
      apiKeyEnv: "INFOMANIAK_API_KEY",
      baseUrl: "https://api.infomaniak.com/2/ai/12345/openai/v1",
    } as never;
    expect(() => normalizeTenantManifest(unqualifiedModel)).toThrow("<provider-id>/<model-id>");

    const undeclaredModel = createManifest();
    undeclaredModel.spec.provider = {
      model: "infomaniak/mistral24b",
      apiKeyEnv: "INFOMANIAK_API_KEY",
      baseUrl: "https://api.infomaniak.com/2/ai/12345/openai/v1",
      models: [{ id: "another-model" }],
    } as never;
    expect(() => normalizeTenantManifest(undeclaredModel)).toThrow("must include mistral24b");

    const insecureEndpoint = createManifest();
    insecureEndpoint.spec.provider = {
      model: "infomaniak/mistral24b",
      apiKeyEnv: "INFOMANIAK_API_KEY",
      baseUrl: "http://api.infomaniak.test/v1",
    } as never;
    expect(() => normalizeTenantManifest(insecureEndpoint)).toThrow("HTTPS");
  });

  it("slows the rendered sync cadence to the plan floor", () => {
    const manifest = createManifest();
    manifest.spec.subscription.planId = "starter";
    manifest.spec.subscription.quotas.minSyncIntervalMinutes = 60;
    const { files } = renderTenantArtifacts(manifest);
    const batch = JSON.parse(files["openclaw.batch.json"]) as Array<{
      path: string;
      value: unknown;
    }>;
    const plugin = batch.find((entry) => entry.path === "plugins.entries.agentbox")?.value as {
      config?: { sync?: { intervalMinutes?: number } };
    };

    expect(plugin.config?.sync?.intervalMinutes).toBe(60);
  });

  it("keeps token mode as operator CLI access", () => {
    const manifest = createManifest();
    manifest.spec.identity = { mode: "token" };
    const { files } = renderTenantArtifacts(manifest);
    const batch = JSON.parse(files["openclaw.batch.json"]) as Array<{
      path: string;
      value: unknown;
    }>;
    const controlUi = batch.find((entry) => entry.path === "gateway.controlUi")?.value as {
      shellProfile?: string;
    };
    const auth = batch.find((entry) => entry.path === "gateway.auth")?.value as { mode?: string };

    expect(controlUi.shellProfile).toBe("full");
    expect(auth.mode).toBe("token");
  });

  it("keeps two customer manifests on disjoint storage identities", () => {
    const acme = renderTenantArtifacts(createManifest());
    const second = createManifest();
    second.metadata.id = "contoso";
    second.metadata.displayName = "Contoso SA";
    second.spec.hostRoot = "/var/lib/agentbox/contoso";
    const contoso = renderTenantArtifacts(second);

    expect(acme.files["docker-compose.override.yml"]).toContain("name: agentbox-acme");
    expect(contoso.files["docker-compose.override.yml"]).toContain("name: agentbox-contoso");
    expect(acme.tenant.hostRoot).not.toBe(contoso.tenant.hostRoot);
    // The corpus now lives in each tenant's own state volume, so separate state
    // directories are the isolation boundary that used to be a separate dataset.
    expect(acme.files[".env"]).toContain("OPENCLAW_CONFIG_DIR=/var/lib/agentbox/acme/state");
    expect(contoso.files[".env"]).toContain("OPENCLAW_CONFIG_DIR=/var/lib/agentbox/contoso/state");
  });
});
