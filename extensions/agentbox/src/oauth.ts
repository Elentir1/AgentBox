import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { z } from "zod";
import { requireConfiguredSecret } from "./config.js";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive().optional(),
  })
  .passthrough();

export type AccessTokenSource = {
  getAccessToken: () => Promise<string>;
  invalidate: () => void;
};

type CachedAccessToken = {
  accessToken: string;
  expiresAtMs: number;
};

const entraTenantIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9.-]{0,126}$/u,
    "Entra tenant id must be a GUID or DNS-safe directory name.",
  );

function expiresAtMs(expiresIn: number | undefined): number {
  const now = Date.now();
  if (!expiresIn) {
    return now;
  }
  return now + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS;
}

async function requestAccessToken(params: {
  url: URL;
  body: URLSearchParams;
  label: string;
}): Promise<CachedAccessToken> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: params.body,
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${params.label} failed (${response.status} ${response.statusText}).`);
  }
  const parsed = tokenResponseSchema.parse(await readProviderJsonResponse(response, params.label));
  return {
    accessToken: parsed.access_token,
    expiresAtMs: expiresAtMs(parsed.expires_in),
  };
}

function createCachedTokenSource(obtain: () => Promise<CachedAccessToken>): AccessTokenSource {
  let cached: CachedAccessToken | undefined;
  return {
    async getAccessToken() {
      if (cached && cached.expiresAtMs > Date.now()) {
        return cached.accessToken;
      }
      cached = await obtain();
      return cached.accessToken;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

export function createMicrosoftClientCredentialsSource(params: {
  sourceId: string;
  entraTenantIdEnv: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}): AccessTokenSource {
  const label = `Microsoft 365 source ${params.sourceId} token`;
  return createCachedTokenSource(async () => {
    const tenantId = entraTenantIdSchema.parse(requireConfiguredSecret(params.entraTenantIdEnv));
    // Token URL pattern matches extensions/msteams/src/oauth.shared.ts
    // buildMSTeamsTokenEndpoint. AgentBox uses client-credentials with Graph
    // /.default, not Teams delegated scopes.
    const url = new URL(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    );
    if (url.origin !== "https://login.microsoftonline.com") {
      throw new Error(`${label} resolved an unsafe token endpoint.`);
    }
    try {
      return await requestAccessToken({
        url,
        body: new URLSearchParams({
          client_id: requireConfiguredSecret(params.clientIdEnv),
          client_secret: requireConfiguredSecret(params.clientSecretEnv),
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        }),
        label,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Microsoft 365 source ${params.sourceId} authentication failed. Renew the Entra app client credentials. ${detail}`,
      );
    }
  });
}

export function createGoogleRefreshTokenSource(params: {
  sourceId: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  refreshTokenEnv: string;
}): AccessTokenSource {
  const label = `Google Drive source ${params.sourceId} token`;
  return createCachedTokenSource(async () => {
    // Standard Google OAuth token URL. Do not reuse Gemini CLI scopes from
    // extensions/google/oauth.shared.ts; Drive read-only is granted when the
    // operator refresh token is minted.
    const url = new URL("https://oauth2.googleapis.com/token");
    try {
      return await requestAccessToken({
        url,
        body: new URLSearchParams({
          client_id: requireConfiguredSecret(params.clientIdEnv),
          client_secret: requireConfiguredSecret(params.clientSecretEnv),
          grant_type: "refresh_token",
          refresh_token: requireConfiguredSecret(params.refreshTokenEnv),
        }),
        label,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Google Drive source ${params.sourceId} authentication failed. Renew the operator refresh token. ${detail}`,
      );
    }
  });
}

export async function fetchWithAccessToken(params: {
  url: string | URL;
  init?: RequestInit;
  tokens: AccessTokenSource;
  timeoutMs: number;
}): Promise<Response> {
  const send = async (accessToken: string) => {
    const headers = new Headers(params.init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    return fetch(params.url, {
      ...params.init,
      headers,
      signal: params.init?.signal ?? AbortSignal.timeout(params.timeoutMs),
    });
  };
  const first = await send(await params.tokens.getAccessToken());
  if (first.status !== 401) {
    return first;
  }
  await first.body?.cancel();
  params.tokens.invalidate();
  return send(await params.tokens.getAccessToken());
}
