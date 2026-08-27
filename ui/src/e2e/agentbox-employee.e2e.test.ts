import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("AgentBox employee experience", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}.`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("brands the product, limits operator routes, and shows document readiness", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      product: { name: "AlpenData AgentBox", shortName: "AgentBox" },
      shellProfile: "auto",
      scopes: ["operator.read", "operator.write"],
      controlUiTabs: [
        {
          group: "control",
          id: "documents",
          label: "Company documents",
          pluginId: "agentbox",
        },
      ],
      featureMethods: ["agentbox.status", "agentbox.sync", "chat.metadata", "chat.startup"],
      methodResponses: {
        "agentbox.status": {
          tenantId: "acme",
          running: true,
          syncInProgress: false,
          lastSyncCompletedAt: "2026-08-27T10:00:00Z",
          sources: [
            {
              id: "finance-sharepoint",
              type: "microsoft-365",
              state: "ready",
              indexed: 42,
              uploaded: 0,
              deleted: 0,
              skipped: 42,
              lastSyncAt: "2026-08-27T10:00:00Z",
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}overview`);
      await expect.poll(() => page.title()).toBe("AlpenData AgentBox");
      const sidebar = page.locator("openclaw-app-sidebar");
      await expect.poll(() => sidebar.getByRole("link", { name: "Settings" }).count()).toBe(0);

      await sidebar.getByRole("button", { name: "More" }).click();
      await sidebar.getByRole("link", { name: "Company documents" }).click();
      await expect
        .poll(() => page.getByRole("heading", { name: "Company knowledge" }).count())
        .toBe(1);
      await expect.poll(() => page.getByText("42 documents available").count()).toBe(1);
      await expect.poll(() => page.getByText("Company documents are searchable").count()).toBe(1);

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifactDir = path.join(
          process.cwd(),
          ".artifacts",
          "control-ui-e2e",
          "agentbox-employee",
        );
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "company-documents.png"),
        });
      }

      await page.goto(`${server.baseUrl}settings/general`);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
    } finally {
      await context.close();
    }
  });

  it("keeps the operator console for administrators", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      product: { name: "AlpenData AgentBox", shortName: "AgentBox" },
      shellProfile: "auto",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      featureMethods: ["chat.metadata", "chat.startup"],
    });

    try {
      await page.goto(`${server.baseUrl}overview`);
      await expect.poll(() => page.title()).toBe("AlpenData AgentBox");
      const sidebar = page.locator("openclaw-app-sidebar");
      await expect.poll(() => sidebar.getByRole("link", { name: "Settings" }).count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
