import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { destroyTenant } from "./destroy-tenant.mjs";
import { restoreTenantBackup } from "./restore-tenant.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function createDeployment() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-operations-"));
  temporaryDirectories.push(parent);
  const hostRoot = path.join(parent, "acme");
  const deployment = {
    id: "acme",
    hostRoot,
    stateDir: path.join(hostRoot, "state"),
    workspaceDir: path.join(hostRoot, "workspace"),
    secretsDir: path.join(hostRoot, "secrets"),
  };
  await fs.mkdir(deployment.stateDir, { recursive: true });
  const deploymentPath = path.join(parent, "deployment.json");
  await fs.writeFile(deploymentPath, JSON.stringify(deployment));
  return { deployment, deploymentPath };
}

describe("AgentBox tenant operations", () => {
  it("restores a verified-layout state asset into the current tenant root", async () => {
    const { deployment, deploymentPath } = await createDeployment();
    await fs.writeFile(path.join(deployment.stateDir, "old.txt"), "old");
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-archive-"));
    temporaryDirectories.push(source);
    const archiveRoot = "2026-08-27T10-00-00.000+00-00-openclaw-backup";
    const archiveState = path.join(
      source,
      archiveRoot,
      "payload",
      "posix",
      "home",
      "node",
      ".openclaw",
    );
    await fs.mkdir(archiveState, { recursive: true });
    await fs.writeFile(path.join(archiveState, "restored.txt"), "restored");
    await fs.writeFile(
      path.join(source, archiveRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        archiveRoot,
        assets: [
          {
            kind: "state",
            sourcePath: "/home/node/.openclaw",
            archivePath: `${archiveRoot}/payload/posix/home/node/.openclaw`,
          },
        ],
      }),
    );
    const archivePath = path.join(source, "backup.tar.gz");
    await tar.c({ gzip: true, cwd: source, file: archivePath }, [archiveRoot]);

    await restoreTenantBackup({
      archivePath,
      deploymentPath,
      confirmTenantId: "acme",
    });

    await expect(fs.readFile(path.join(deployment.stateDir, "restored.txt"), "utf8")).resolves.toBe(
      "restored",
    );
    await expect(fs.stat(path.join(deployment.stateDir, "old.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires the exact tenant id before deletion", async () => {
    const { deployment, deploymentPath } = await createDeployment();
    await expect(destroyTenant({ deploymentPath, confirmTenantId: "other" })).rejects.toThrow(
      "does not match",
    );
    await expect(fs.stat(deployment.hostRoot)).resolves.toBeDefined();

    await destroyTenant({ deploymentPath, confirmTenantId: "acme" });
    await expect(fs.stat(deployment.hostRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
