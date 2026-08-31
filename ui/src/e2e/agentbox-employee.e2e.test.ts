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

const employeeGateway = {
  product: { name: "AlpenData AgentBox", shortName: "AgentBox" },
  shellProfile: "auto" as const,
  scopes: ["operator.read", "operator.write"],
  controlUiTabs: [
    {
      group: "control" as const,
      id: "documents",
      label: "Company documents",
      pluginId: "agentbox",
    },
  ],
  featureMethods: ["agentbox.status", "agentbox.sync", "chat.metadata", "chat.startup"],
};

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

  it("shows an honest empty corpus instead of demo document counts", async () => {
    const context = await browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      ...employeeGateway,
      methodResponses: {
        "agentbox.status": {
          tenantId: "pilot",
          running: true,
          syncInProgress: false,
          backend: { state: "ready" },
          sources: [],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}overview`);
      await expect.poll(() => page.title()).toBe("AlpenData AgentBox");
      const sidebar = page.locator("openclaw-app-sidebar");
      await expect.poll(() => sidebar.getByRole("link", { name: "Settings" }).count()).toBe(0);
      await expect
        .poll(() => sidebar.getByRole("link", { name: "Company documents" }).count())
        .toBe(1);

      await sidebar.getByRole("link", { name: "Company documents" }).click();
      await expect
        .poll(() => page.getByRole("heading", { name: "Company knowledge" }).count())
        .toBe(1);
      await expect.poll(() => page.getByText("No document source configured").count()).toBe(1);
      await expect.poll(() => page.getByText("42 documents available").count()).toBe(0);
      await expect.poll(() => page.getByText("Company documents are searchable").count()).toBe(0);

      const artifactDir = path.join(
        process.cwd(),
        ".artifacts",
        "control-ui-e2e",
        "agentbox-employee",
      );
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "company-documents-empty.png"),
      });
    } finally {
      await context.close();
    }
  });

  it("surfaces a RAGFlow backend error instead of an all-clear checklist", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      ...employeeGateway,
      methodResponses: {
        "agentbox.status": {
          tenantId: "pilot",
          running: true,
          syncInProgress: false,
          backend: {
            state: "error",
            error: "RAGFlow is unreachable: ECONNREFUSED",
          },
          sources: [
            {
              id: "kdrive",
              type: "webdav",
              state: "error",
              indexed: 0,
              uploaded: 0,
              deleted: 0,
              skipped: 0,
              error: "RAGFlow is unreachable: ECONNREFUSED",
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}overview`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("link", { name: "Company documents" }).click();
      await expect
        .poll(() => page.getByRole("alert").filter({ hasText: "RAGFlow" }).count())
        .toBe(1);
      await expect
        .poll(() => page.getByText("Every source synchronized successfully").count())
        .toBe(0);
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
