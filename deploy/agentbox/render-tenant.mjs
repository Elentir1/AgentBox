#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]+$/u;
const SOURCE_TYPES = new Set(["google-drive", "local", "microsoft-365", "webdav"]);

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
      accessTokenEnv: requireEnvName(source.accessTokenEnv, `source ${id}.accessTokenEnv`),
    };
  }
  if (type === "google-drive") {
    return {
      id,
      type,
      driveId: typeof source.driveId === "string" ? source.driveId.trim() : undefined,
      accessTokenEnv: requireEnvName(source.accessTokenEnv, `source ${id}.accessTokenEnv`),
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
  if (!path.isAbsolute(spec.hostRoot) || hostRoot === "/") {
    throw new Error("spec.hostRoot must be an absolute tenant-specific directory.");
  }
  const provider = requireRecord(spec.provider, "spec.provider");
  const documents = requireRecord(spec.documents, "spec.documents");
  const backend = requireRecord(documents.backend, "spec.documents.backend");
  const identity = requireRecord(spec.identity ?? { mode: "token" }, "spec.identity");
  const identityMode = identity.mode === "trusted-proxy" ? "trusted-proxy" : "token";
  if (
    identityMode === "trusted-proxy" &&
    !requireString(identity.userHeader, "identity.userHeader")
  ) {
    throw new Error("identity.userHeader is required for trusted-proxy mode.");
  }
  const sources = Array.isArray(documents.sources) ? documents.sources.map(normalizeSource) : [];
  if (sources.length === 0 || new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error("spec.documents.sources must contain unique sources.");
  }
  const gatewayPort = Number(spec.gatewayPort ?? 18789);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) {
    throw new Error("spec.gatewayPort must be an integer between 1024 and 65535.");
  }
  const backendBaseUrl = requireHttpUrl(backend.baseUrl, "spec.documents.backend.baseUrl");
  const backendAllowsPrivateNetwork = backend.allowPrivateNetwork === true;
  if (backendBaseUrl.startsWith("http://") && !backendAllowsPrivateNetwork) {
    throw new Error(
      "HTTP document backends require spec.documents.backend.allowPrivateNetwork: true.",
    );
  }
  return {
    id,
    displayName: requireString(metadata.displayName, "metadata.displayName"),
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
    provider: {
      model: requireString(provider.model, "spec.provider.model"),
      apiKeyEnv: requireEnvName(provider.apiKeyEnv, "spec.provider.apiKeyEnv"),
    },
    documents: {
      backend: {
        baseUrl: backendBaseUrl,
        datasetId: requireString(backend.datasetId, "spec.documents.backend.datasetId"),
        apiKeyEnv: requireEnvName(backend.apiKeyEnv, "spec.documents.backend.apiKeyEnv"),
        allowPrivateNetwork: backendAllowsPrivateNetwork,
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
      docsUrl: "https://www.alpendata.ch/agentbox/docs",
      supportUrl: "https://www.alpendata.ch/contact",
      privacyUrl: "https://www.alpendata.ch/privacy",
    },
    shellProfile: "auto",
  };
  const pluginEntry = {
    enabled: true,
    config: {
      tenantId: tenant.id,
      backend: tenant.documents.backend,
      sync: { intervalMinutes: 15 },
      sources: tenant.documents.sources.map((source) =>
        source.type === "local" ? { ...source, root: `/agentbox/sources/${source.id}` } : source,
      ),
    },
  };
  const configBatch = [
    { path: "agents.defaults.model", value: { primary: tenant.provider.model } },
    { path: "gateway.auth", value: renderGatewayAuth(tenant) },
    ...(tenant.identity.mode === "trusted-proxy"
      ? [{ path: "gateway.trustedProxies", value: tenant.identity.trustedProxies }]
      : []),
    { path: "gateway.controlUi", value: controlUi },
    { path: "gateway.terminal.enabled", value: false },
    { path: "ui.seamColor", value: "#0F766E" },
    { path: "plugins.entries.agentbox", value: pluginEntry },
  ];
  const secretNames = new Set([
    "OPENCLAW_GATEWAY_TOKEN",
    tenant.provider.apiKeyEnv,
    tenant.documents.backend.apiKeyEnv,
  ]);
  for (const source of tenant.documents.sources) {
    for (const key of ["accessTokenEnv", "usernameEnv", "passwordEnv"]) {
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
    },
  };
}

export async function renderTenantFile(manifestPath, outputDir) {
  const source = await fs.readFile(manifestPath, "utf8");
  const artifacts = renderTenantArtifacts(parseYaml(source));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o750 });
  for (const [name, content] of Object.entries(artifacts.files)) {
    await fs.writeFile(path.join(outputDir, name), content, {
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
