#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function destroyTenant({ deploymentPath, confirmTenantId }) {
  const deployment = JSON.parse(await fs.readFile(deploymentPath, "utf8"));
  if (deployment.id !== confirmTenantId) {
    throw new Error("Confirmation tenant id does not match deployment.json.");
  }
  const hostRoot = path.resolve(String(deployment.hostRoot));
  if (
    hostRoot === "/" ||
    hostRoot === path.parse(hostRoot).root ||
    !hostRoot.split(path.sep).includes(confirmTenantId)
  ) {
    throw new Error("Refusing to remove a non-tenant-specific host root.");
  }
  await fs.rm(hostRoot, { recursive: true, force: false });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const [deploymentPath, confirmTenantId] = process.argv.slice(2);
  if (!deploymentPath || !confirmTenantId) {
    console.error(
      "Usage: node deploy/agentbox/destroy-tenant.mjs <deployment.json> <confirm-tenant-id>",
    );
    process.exitCode = 2;
  } else {
    await destroyTenant({
      deploymentPath: path.resolve(deploymentPath),
      confirmTenantId,
    });
    console.log(`Deleted all local data for AgentBox tenant ${confirmTenantId}.`);
  }
}
