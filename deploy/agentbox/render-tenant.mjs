#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]+$/u;
const SOURCE_TYPES = new Set(["google-drive", "local", "microsoft-365", "webdav"]);
const SUBSCRIPTION_STATUSES = new Set(["active", "grace", "suspended"]);
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const PROVIDER_APIS = new Set(["openai-completions", "openai-responses"]);

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireEnvName(value, label) {
  const name = requireString(value, label);
  if (!ENV_NAME_RE.test(name)) {
    throw new Error(`${label} must be an uppercase environment variable name.`);
  }
  return name;
}

function requireHttpUrl(value, label, { httpsOnly = false } = {}) {
  const raw = requireString(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  const allowed = httpsOnly
    ? url.protocol === "https:"
    : ["http:", "https:"].includes(url.protocol);
  if (!allowed || url.username || url.password) {
    throw new Error(`${label} must be a credential-free ${httpsOnly ? "HTTPS" : "HTTP(S)"} URL.`);
  }
  return url.toString().replace(/\/$/u, "");
}

function requireQuota(value, label, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function normalizeProviderModel(value, index) {
  const entry = requireRecord(value, `spec.provider.models[${index}]`);
  const id = requireString(entry.id, `spec.provider.models[${index}].id`);
  const model = {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
  };
  for (const key of ["contextWindow", "maxTokens"]) {
    if (entry[key] !== undefined) {
      if (!Number.isInteger(entry[key]) || entry[key] < 1) {
        throw new Error(`spec.provider.models[${index}].${key} must be a positive integer.`);
      }
      model[key] = entry[key];
    }
  }
  return model;
}

function normalizeProvider(value) {
  const provider = requireRecord(value, "spec.provider");
  const model = requireString(provider.model, "spec.provider.model");
  const apiKeyEnv = requireEnvName(provider.apiKeyEnv, "spec.provider.apiKeyEnv");
  if (provider.baseUrl === undefined) {
    // Hosted providers ship their own catalog; a bare endpoint override would be
    // half a provider definition and would fail model resolution at runtime.
    if (provider.api !== undefined || provider.models !== undefined) {
      throw new Error("spec.provider.api and spec.provider.models require spec.provider.baseUrl.");
    }
    return { model, apiKeyEnv };
  }
  const baseUrl = requireHttpUrl(provider.baseUrl, "spec.provider.baseUrl", { httpsOnly: true });
  const separator = model.indexOf("/");
  if (separator < 1 || separator === model.length - 1) {
    throw new Error(
      "spec.provider.model must be <provider-id>/<model-id> when spec.provider.baseUrl is set.",
    );
  }
  const id = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  if (!TENANT_ID_RE.test(id)) {
    throw new Error("spec.provider.model provider id must be a lowercase DNS-safe identifier.");
  }
  const api = provider.api === undefined ? "openai-completions" : provider.api;
  if (!PROVIDER_APIS.has(api)) {
    throw new Error("spec.provider.api must be openai-completions or openai-responses.");
  }
  const models =
    provider.models === undefined
      ? [{ id: modelId, name: modelId }]
      : (Array.isArray(provider.models) ? provider.models : []).map(normalizeProviderModel);
  if (models.length === 0) {
    throw new Error("spec.provider.models must list at least one model.");
  }
  // The primary model ref is resolved against this catalog, so a manifest that
  // names a model it does not declare would provision a Gateway that cannot answer.
  if (!models.some((entry) => entry.id === modelId)) {
    throw new Error(`spec.provider.models must include ${modelId}.`);
  }
  return { model, apiKeyEnv, endpoint: { id, baseUrl, api, models } };
}

function normalizeSubscription(value, sourceCount) {
  const subscription = requireRecord(value, "spec.subscription");
  const planId = requireString(subscription.planId, "spec.subscription.planId");
  if (!TENANT_ID_RE.test(planId)) {
    throw new Error("spec.subscription.planId must be a lowercase DNS-safe identifier.");
  }
  const status = requireString(subscription.status, "spec.subscription.status");
  if (!SUBSCRIPTION_STATUSES.has(status)) {
    throw new Error("spec.subscription.status must be active, grace, or suspended.");
  }
  const quotas = requireRecord(subscription.quotas, "spec.subscription.quotas");
  // The document index is bounded by AGENTBOX_STATE_MAX_ENTRIES in the plugin
  // state store. A tier may not sell a corpus the runtime cannot track.
  const maxDocuments = requireQuota(quotas.maxDocuments, "quotas.maxDocuments", {
    min: 1,
    max: 50_000,
  });
  const maxSources = requireQuota(quotas.maxSources, "quotas.maxSources", { min: 1, max: 50 });
  if (sourceCount > maxSources) {
    throw new Error(
      `spec.documents.sources has ${sourceCount} sources but the plan allows ${maxSources}.`,
    );
  }
  let validUntil;
  if (subscription.validUntil !== undefined) {
    const raw = requireString(subscription.validUntil, "spec.subscription.validUntil");
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("spec.subscription.validUntil must be an ISO 8601 timestamp.");
    }
    validUntil = parsed.toISOString();
  }
  return {
    planId,
    status,
    validUntil,
    quotas: {
      maxSources,
      maxDocuments,
      maxStorageBytes: requireQuota(quotas.maxStorageBytes, "quotas.maxStorageBytes", {
        min: 1024 * 1024,
        max: Number.MAX_SAFE_INTEGER,
      }),
      minSyncIntervalMinutes: requireQuota(
        quotas.minSyncIntervalMinutes,
        "quotas.minSyncIntervalMinutes",
        { min: 1, max: 1440 },
      ),
    },
  };
}

function normalizeSource(value, index) {
  const source = requireRecord(value, `spec.documents.sources[${index}]`);
  const id = requireString(source.id, `source[${index}].id`);
  const type = requireString(source.type, `source[${index}].type`);
  if (!TENANT_ID_RE.test(id) || !SOURCE_TYPES.has(type)) {
    throw new Error(`source[${index}] has an invalid id or type.`);
  }
  if (type === "local") {
    const root = requireString(source.root, `source ${id}.root`);
    if (!path.isAbsolute(root)) {
      throw new Error(`source ${id}.root must be an absolute host path.`);
    }
    return { id, type, root };
  }
  if (type === "microsoft-365") {
    return {
      id,
      type,
      driveId: requireString(source.driveId, `source ${id}.driveId`),
      entraTenantIdEnv: requireEnvName(source.entraTenantIdEnv, `source ${id}.entraTenantIdEnv`),
      clientIdEnv: requireEnvName(source.clientIdEnv, `source ${id}.clientIdEnv`),
      clientSecretEnv: requireEnvName(source.clientSecretEnv, `source ${id}.clientSecretEnv`),
    };
  }
  if (type === "google-drive") {
    return {
      id,
      type,
      driveId: typeof source.driveId === "string" ? source.driveId.trim() : undefined,
      clientIdEnv: requireEnvName(source.clientIdEnv, `source ${id}.clientIdEnv`),
      clientSecretEnv: requireEnvName(source.clientSecretEnv, `source ${id}.clientSecretEnv`),
      refreshTokenEnv: requireEnvName(source.refreshTokenEnv, `source ${id}.refreshTokenEnv`),
    };
  }
  return {
    id,
    type,
    baseUrl: requireHttpUrl(source.baseUrl, `source ${id}.baseUrl`, { httpsOnly: true }),
    rootPath: typeof source.rootPath === "string" && source.rootPath.trim() ? source.rootPath : "/",
    usernameEnv: requireEnvName(source.usernameEnv, `source ${id}.usernameEnv`),
    passwordEnv: requireEnvName(source.passwordEnv, `source ${id}.passwordEnv`),
    allowPrivateNetwork: source.allowPrivateNetwork === true,
  };
}

export function normalizeTenantManifest(input) {
  const manifest = requireRecord(input, "manifest");
  if (manifest.apiVersion !== "agentbox.alpendata.ch/v1" || manifest.kind !== "Tenant") {
    throw new Error("manifest must use apiVersion agentbox.alpendata.ch/v1 and kind Tenant.");
  }
  const metadata = requireRecord(manifest.metadata, "metadata");
  const spec = requireRecord(manifest.spec, "spec");
  const id = requireString(metadata.id, "metadata.id");
  if (!TENANT_ID_RE.test(id)) {
    throw new Error("metadata.id must be a lowercase DNS-safe identifier.");
  }
  const hostRoot = path.resolve(requireString(spec.hostRoot, "spec.hostRoot"));
  // Destroy/restore refuse paths that do not contain the tenant id; keep render
  // aligned so one customer cannot be provisioned onto another customer's root.
  if (
    !path.isAbsolute(spec.hostRoot) ||
    hostRoot === "/" ||
    hostRoot === path.parse(hostRoot).root ||
    !hostRoot.split(path.sep).includes(id)
  ) {
    throw new Error("spec.hostRoot must be an absolute directory that contains the tenant id.");
  }
  const documents = requireRecord(spec.documents, "spec.documents");
  const embedding = requireRecord(documents.embedding, "spec.documents.embedding");
  const identity = requireRecord(spec.identity, "spec.identity");
  const identityModeRaw = requireString(identity.mode, "spec.identity.mode");
  if (identityModeRaw !== "trusted-proxy" && identityModeRaw !== "token") {
    throw new Error("spec.identity.mode must be trusted-proxy or token.");
  }
  const identityMode = identityModeRaw;
  if (identityMode === "trusted-proxy") {
    requireString(identity.userHeader, "identity.userHeader");
    if (!Array.isArray(identity.trustedProxies) || identity.trustedProxies.length === 0) {
      throw new Error("identity.trustedProxies is required for trusted-proxy mode.");
    }
  }
  const sources = Array.isArray(documents.sources) ? documents.sources.map(normalizeSource) : [];
  if (sources.length === 0 || new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error("spec.documents.sources must contain unique sources.");
  }
  const gatewayPort = Number(spec.gatewayPort ?? 18789);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) {
    throw new Error("spec.gatewayPort must be an integer between 1024 and 65535.");
  }
  const embeddingBaseUrl = requireHttpUrl(embedding.baseUrl, "spec.documents.embedding.baseUrl");
  const embeddingAllowsPrivateNetwork = embedding.allowPrivateNetwork === true;
  // Document text is sent to this endpoint, so plaintext HTTP is an explicit,
  // private-network-only acknowledgement rather than a default.
  if (embeddingBaseUrl.startsWith("http://") && !embeddingAllowsPrivateNetwork) {
    throw new Error(
      "HTTP embedding endpoints require spec.documents.embedding.allowPrivateNetwork: true.",
    );
  }
  if (
    embedding.dimensions !== undefined &&
    (!Number.isInteger(embedding.dimensions) || embedding.dimensions < 1)
  ) {
    throw new Error("spec.documents.embedding.dimensions must be a positive integer.");
  }
  return {
    id,
    displayName: requireString(metadata.displayName, "metadata.displayName"),
    subscription: normalizeSubscription(spec.subscription, sources.length),
    image: requireString(spec.image, "spec.image"),
    hostRoot,
    publicOrigin: requireHttpUrl(spec.publicOrigin, "spec.publicOrigin", { httpsOnly: true }),
    gatewayPort,
    timezone:
      typeof spec.timezone === "string" && spec.timezone.trim()
        ? spec.timezone.trim()
        : "Europe/Zurich",
    identity: {
      mode: identityMode,
      trustedProxies: Array.isArray(identity.trustedProxies)
        ? identity.trustedProxies.map((entry) => requireString(entry, "identity.trustedProxies[]"))
        : [],
      userHeader:
        identityMode === "trusted-proxy"
          ? requireString(identity.userHeader, "identity.userHeader")
          : undefined,
      requiredHeaders: Array.isArray(identity.requiredHeaders)
        ? [
            ...new Set([
              ...identity.requiredHeaders.map((entry) =>
                requireString(entry, "identity.requiredHeaders[]"),
              ),
              ...(identityMode === "trusted-proxy" ? ["x-openclaw-scopes"] : []),
            ]),
          ]
        : identityMode === "trusted-proxy"
          ? ["x-openclaw-scopes"]
          : [],
      allowUsers: Array.isArray(identity.allowUsers)
        ? identity.allowUsers.map((entry) => requireString(entry, "identity.allowUsers[]"))
        : [],
    },
    provider: normalizeProvider(spec.provider),
    documents: {
      embedding: {
        baseUrl: embeddingBaseUrl,
        model: requireString(embedding.model, "spec.documents.embedding.model"),
        apiKeyEnv: requireEnvName(embedding.apiKeyEnv, "spec.documents.embedding.apiKeyEnv"),
        ...(embedding.dimensions === undefined ? {} : { dimensions: embedding.dimensions }),
        allowPrivateNetwork: embeddingAllowsPrivateNetwork,
      },
      sources,
    },
    retentionDays:
      Number.isInteger(spec.backup?.retentionDays) && spec.backup.retentionDays > 0
        ? spec.backup.retentionDays
        : 30,
  };
}

function renderGatewayAuth(tenant) {
  if (tenant.identity.mode === "token") {
    return {
      mode: "token",
      token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
    };
  }
  return {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: tenant.identity.userHeader,
      requiredHeaders: tenant.identity.requiredHeaders,
      allowUsers: tenant.identity.allowUsers,
    },
  };
}

export function renderTenantArtifacts(input) {
  const tenant = normalizeTenantManifest(input);
  const stateDir = path.join(tenant.hostRoot, "state");
  const workspaceDir = path.join(tenant.hostRoot, "workspace");
  const secretsDir = path.join(tenant.hostRoot, "secrets");
  const backupDir = path.join(tenant.hostRoot, "backups");
  const env = [
    `OPENCLAW_IMAGE=${tenant.image}`,
    `OPENCLAW_CONFIG_DIR=${stateDir}`,
    `OPENCLAW_WORKSPACE_DIR=${workspaceDir}`,
    `OPENCLAW_AUTH_PROFILE_SECRET_DIR=${path.join(secretsDir, "auth-profiles")}`,
    `OPENCLAW_GATEWAY_PORT=${tenant.gatewayPort}`,
    "OPENCLAW_GATEWAY_BIND=lan",
    // The tenant Gateway is reached only through the TLS/identity proxy. Publishing
    // on loopback keeps it off the host's public interfaces; the proxy still
    // arrives from the Docker bridge, which trusted-proxy auth treats as remote.
    "OPENCLAW_PUBLISH_ADDRESS=127.0.0.1",
    `OPENCLAW_TZ=${tenant.timezone}`,
    `AGENTBOX_TENANT_ID=${tenant.id}`,
    `AGENTBOX_BACKUP_RETENTION_DAYS=${tenant.retentionDays}`,
    "",
  ].join("\n");
  const localVolumes = tenant.documents.sources
    .filter((source) => source.type === "local")
    .map((source) => `${source.root}:/agentbox/sources/${source.id}:ro`);
  const serviceOverride = {
    env_file: [{ path: path.join(secretsDir, "runtime.env"), required: true }],
    environment: { AGENTBOX_TENANT_ID: tenant.id },
    volumes: [`${backupDir}:/agentbox/backups`, ...localVolumes],
  };
  const compose = stringifyYaml({
    name: `agentbox-${tenant.id}`,
    services: {
      "openclaw-gateway": serviceOverride,
      "openclaw-cli": serviceOverride,
    },
  });
  const controlUi = {
    allowedOrigins: [tenant.publicOrigin],
    product: {
      name: "AlpenData AgentBox",
      shortName: "AgentBox",
      logoPath: "/agentbox-logo.svg",
      faviconPath: "/agentbox-favicon.svg",
      supportUrl: "https://www.alpendata.ch/contact",
    },
    // Employee tenants hide CLI login. Token mode is AlpenData operator access.
    shellProfile: tenant.identity.mode === "trusted-proxy" ? "auto" : "full",
  };
  const pluginEntry = {
    enabled: true,
    config: {
      tenantId: tenant.id,
      index: { embedding: tenant.documents.embedding },
      entitlements: tenant.subscription,
      // The product default only applies when the plan allows it; a slower plan
      // floor wins so the rendered config never asks for a cadence it cannot buy.
      sync: {
        intervalMinutes: Math.max(
          DEFAULT_SYNC_INTERVAL_MINUTES,
          tenant.subscription.quotas.minSyncIntervalMinutes,
        ),
      },
      sources: tenant.documents.sources.map((source) =>
        source.type === "local" ? { ...source, root: `/agentbox/sources/${source.id}` } : source,
      ),
    },
  };
  const configBatch = [
    ...(tenant.provider.endpoint
      ? [
          {
            path: `models.providers.${tenant.provider.endpoint.id}`,
            value: {
              baseUrl: tenant.provider.endpoint.baseUrl,
              api: tenant.provider.endpoint.api,
              apiKey: { source: "env", provider: "default", id: tenant.provider.apiKeyEnv },
              models: tenant.provider.endpoint.models,
            },
          },
        ]
      : []),
    { path: "agents.defaults.model", value: { primary: tenant.provider.model } },
    { path: "gateway.auth", value: renderGatewayAuth(tenant) },
    ...(tenant.identity.mode === "trusted-proxy"
      ? [{ path: "gateway.trustedProxies", value: tenant.identity.trustedProxies }]
      : []),
    { path: "gateway.controlUi", value: controlUi },
    { path: "gateway.terminal.enabled", value: false },
    { path: "ui.seamColor", value: "#dc2626" },
    { path: "plugins.entries.agentbox", value: pluginEntry },
  ];
  const secretNames = new Set([
    "OPENCLAW_GATEWAY_TOKEN",
    tenant.provider.apiKeyEnv,
    tenant.documents.embedding.apiKeyEnv,
  ]);
  for (const source of tenant.documents.sources) {
    for (const key of [
      "entraTenantIdEnv",
      "clientIdEnv",
      "clientSecretEnv",
      "refreshTokenEnv",
      "usernameEnv",
      "passwordEnv",
    ]) {
      if (source[key]) {
        secretNames.add(source[key]);
      }
    }
  }
  return {
    tenant,
    files: {
      ".env": env,
      "docker-compose.override.yml": compose,
      "openclaw.batch.json": `${JSON.stringify(configBatch, null, 2)}\n`,
      "deployment.json": `${JSON.stringify(
        {
          id: tenant.id,
          hostRoot: tenant.hostRoot,
          stateDir,
          workspaceDir,
          secretsDir,
          backupDir,
          gatewayPort: tenant.gatewayPort,
        },
        null,
        2,
      )}\n`,
      "runtime.env.example": `${[...secretNames]
        .sort()
        .map((name) => `${name}=`)
        .join("\n")}\n`,
      "workspace/AGENTS.md": renderWorkspaceAgents(tenant.displayName),
    },
  };
}

function renderWorkspaceAgents(displayName) {
  return `# ${displayName} assistant

You answer employees using only company documents retrieved through the \`agentbox_search\` tool.

- Call \`agentbox_search\` before citing any internal policy, contract, or file.
- Cite only document names and excerpts the tool returned.
- If the tool returns no authorized match, say the company corpus does not contain the answer. Do not invent SharePoint, Drive, or kDrive sources.
- Do not use general web knowledge as a substitute for missing internal documents.
- Every employee on this AgentBox can search the same company corpus. There is no per-file ACL in this version.
`;
}

export async function renderTenantFile(manifestPath, outputDir) {
  const source = await fs.readFile(manifestPath, "utf8");
  const artifacts = renderTenantArtifacts(parseYaml(source));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o750 });
  for (const [name, content] of Object.entries(artifacts.files)) {
    const filePath = path.join(outputDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
    await fs.writeFile(filePath, content, {
      mode: name === ".env" ? 0o640 : 0o644,
    });
  }
  return artifacts;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const [manifestPath, outputDir] = process.argv.slice(2);
  if (!manifestPath || !outputDir) {
    console.error("Usage: node deploy/agentbox/render-tenant.mjs <tenant.yaml> <output-dir>");
    process.exitCode = 2;
  } else {
    const result = await renderTenantFile(manifestPath, outputDir);
    console.log(`Rendered AgentBox tenant ${result.tenant.id} into ${path.resolve(outputDir)}`);
  }
}
