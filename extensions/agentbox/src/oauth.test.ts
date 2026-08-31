import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleRefreshTokenSource,
  createMicrosoftClientCredentialsSource,
  fetchWithAccessToken,
} from "./oauth.js";

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENTBOX_MS_TENANT_ID;
  delete process.env.AGENTBOX_MS_CLIENT_ID;
  delete process.env.AGENTBOX_MS_CLIENT_SECRET;
  delete process.env.AGENTBOX_GOOGLE_CLIENT_ID;
  delete process.env.AGENTBOX_GOOGLE_CLIENT_SECRET;
  delete process.env.AGENTBOX_GOOGLE_REFRESH_TOKEN;
});

describe("AgentBox source OAuth", () => {
  it("mints a Graph client-credentials token and retries once after 401", async () => {
    process.env.AGENTBOX_MS_TENANT_ID = "tenant-guid";
    process.env.AGENTBOX_MS_CLIENT_ID = "client-id";
    process.env.AGENTBOX_MS_CLIENT_SECRET = "client-secret";
    const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url.includes("login.microsoftonline.com")) {
          return Response.json({ access_token: `graph-${requests.length}`, expires_in: 3600 });
        }
        if (
          requests.filter((request) => request.url.includes("graph.microsoft.com")).length === 1
        ) {
          return new Response("expired", { status: 401, statusText: "Unauthorized" });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const tokens = createMicrosoftClientCredentialsSource({
      sourceId: "sharepoint",
      entraTenantIdEnv: "AGENTBOX_MS_TENANT_ID",
      clientIdEnv: "AGENTBOX_MS_CLIENT_ID",
      clientSecretEnv: "AGENTBOX_MS_CLIENT_SECRET",
    });
    const response = await fetchWithAccessToken({
      url: "https://graph.microsoft.com/v1.0/drives/drive/root/delta",
      tokens,
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(requests.map((request) => request.url)).toEqual([
      "https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token",
      "https://graph.microsoft.com/v1.0/drives/drive/root/delta",
      "https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token",
      "https://graph.microsoft.com/v1.0/drives/drive/root/delta",
    ]);
    expect(requests[0]?.body).toContain("grant_type=client_credentials");
    expect(requests[0]?.body).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    expect(requests[1]?.authorization).toBe("Bearer graph-1");
    expect(requests[3]?.authorization).toBe("Bearer graph-3");
  });

  it("refreshes a Google Drive access token and retries once after 401", async () => {
    process.env.AGENTBOX_GOOGLE_CLIENT_ID = "client-id";
    process.env.AGENTBOX_GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.AGENTBOX_GOOGLE_REFRESH_TOKEN = "refresh-token";
    const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: `drive-${requests.length}`, expires_in: 3600 });
        }
        if (
          requests.filter((request) => request.url.includes("googleapis.com/drive")).length === 1
        ) {
          return new Response("expired", { status: 401, statusText: "Unauthorized" });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const tokens = createGoogleRefreshTokenSource({
      sourceId: "drive",
      clientIdEnv: "AGENTBOX_GOOGLE_CLIENT_ID",
      clientSecretEnv: "AGENTBOX_GOOGLE_CLIENT_SECRET",
      refreshTokenEnv: "AGENTBOX_GOOGLE_REFRESH_TOKEN",
    });
    const response = await fetchWithAccessToken({
      url: "https://www.googleapis.com/drive/v3/files",
      tokens,
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(200);
    expect(requests[0]?.body).toContain("grant_type=refresh_token");
    expect(requests[0]?.body).toContain("refresh_token=refresh-token");
    expect(requests[1]?.authorization).toBe("Bearer drive-1");
    expect(requests[3]?.authorization).toBe("Bearer drive-3");
  });

  it("fails closed when Microsoft client-credentials cannot be minted", async () => {
    process.env.AGENTBOX_MS_TENANT_ID = "tenant-guid";
    process.env.AGENTBOX_MS_CLIENT_ID = "client-id";
    process.env.AGENTBOX_MS_CLIENT_SECRET = "client-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 400, statusText: "Bad Request" })),
    );

    const tokens = createMicrosoftClientCredentialsSource({
      sourceId: "sharepoint",
      entraTenantIdEnv: "AGENTBOX_MS_TENANT_ID",
      clientIdEnv: "AGENTBOX_MS_CLIENT_ID",
      clientSecretEnv: "AGENTBOX_MS_CLIENT_SECRET",
    });
    await expect(tokens.getAccessToken()).rejects.toThrow("Renew the Entra app client credentials");
  });
});
