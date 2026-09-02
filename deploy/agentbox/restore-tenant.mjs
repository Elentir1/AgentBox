#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import * as tar from "tar";

function safeArchivePath(value, archiveRoot) {
  if (
    typeof value !== "string" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    !value.startsWith(`${archiveRoot}/payload/`)
  ) {
    throw new Error(`Unsafe backup archive path: ${String(value)}`);
  }
  return value;
}

async function readManifest(archivePath) {
  let raw;
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry(entry) {
      if (!entry.path.endsWith("/manifest.json")) {
        entry.resume();
        return;
      }
      const chunks = [];
      entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      entry.on("end", () => {
        raw = Buffer.concat(chunks).toString("utf8");
      });
    },
  });
  if (!raw) {
    throw new Error("Backup manifest was not found.");
  }
  const manifest = JSON.parse(raw);
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.archiveRoot !== "string" ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error("Unsupported backup manifest.");
  }
  return manifest;
}

function destinationForAsset(asset, deployment) {
  switch (asset.kind) {
    case "state":
      return deployment.stateDir;
    case "workspace":
      return deployment.workspaceDir;
    case "credentials":
      return path.join(deployment.secretsDir, "auth-profiles");
    case "config":
      return path.join(deployment.stateDir, "openclaw.json");
    default:
      throw new Error(`Unsupported backup asset kind: ${String(asset.kind)}`);
  }
}

export async function restoreTenantBackup({ archivePath, deploymentPath, confirmTenantId }) {
  const deployment = JSON.parse(await fs.readFile(deploymentPath, "utf8"));
  if (deployment.id !== confirmTenantId) {
    throw new Error("Confirmation tenant id does not match deployment.json.");
  }
  const manifest = await readManifest(archivePath);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), `agentbox-restore-${deployment.id}-`));
  const rollbackRoot = path.join(deployment.hostRoot, `.restore-rollback-${Date.now()}`);
  const moved = [];
  try {
    await tar.x({
      file: archivePath,
      cwd: staging,
      gzip: true,
      strict: true,
      preservePaths: false,
    });
    await fs.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
    for (const asset of manifest.assets) {
      const relative = safeArchivePath(asset.archivePath, manifest.archiveRoot);
      const extracted = path.join(staging, ...relative.split("/"));
      const destination = destinationForAsset(asset, deployment);
      const rollback = path.join(rollbackRoot, asset.kind);
      try {
        await fs.rename(destination, rollback);
        moved.push({ destination, rollback });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
      await fs.cp(extracted, destination, { recursive: true, force: false, errorOnExist: true });
    }
    await fs.rm(rollbackRoot, { recursive: true, force: true });
  } catch (error) {
    for (const entry of moved.toReversed()) {
      await fs.rm(entry.destination, { recursive: true, force: true });
      await fs.rename(entry.rollback, entry.destination);
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const [archivePath, deploymentPath, confirmTenantId] = process.argv.slice(2);
  if (!archivePath || !deploymentPath || !confirmTenantId) {
    console.error(
      "Usage: node deploy/agentbox/restore-tenant.mjs <archive> <deployment.json> <confirm-tenant-id>",
    );
    process.exitCode = 2;
  } else {
    await restoreTenantBackup({
      archivePath: path.resolve(archivePath),
      deploymentPath: path.resolve(deploymentPath),
      confirmTenantId,
    });
    console.log(`Restored AgentBox tenant ${confirmTenantId}.`);
  }
}
