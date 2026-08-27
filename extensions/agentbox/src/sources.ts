import fs from "node:fs/promises";
import path from "node:path";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import type { AgentBoxSourceConfig } from "./config.js";
import { requireConfiguredSecret } from "./config.js";

const MAX_SOURCE_ITEMS = 50_000;
const SUPPORTED_LOCAL_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".html",
  ".md",
  ".ods",
  ".odt",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rtf",
  ".txt",
  ".xls",
  ".xlsx",
]);

export type AgentBoxDocument = {
  key: string;
  name: string;
  mimeType?: string;
  modifiedAtMs: number;
  size: number;
  fingerprint: string;
  sourceUrl?: string;
  read: () => Promise<Uint8Array>;
};

export type AgentBoxSourceScan = {
  mode: "delta" | "snapshot";
  documents: AgentBoxDocument[];
  deletedKeys: string[];
  cursor?: string;
};

export type AgentBoxSourceAdapter = {
  id: string;
  scan: (cursor?: string) => Promise<AgentBoxSourceScan>;
};

function assertResponseOk(response: Response, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status} ${response.statusText})`);
  }
}

function assertItemLimit(count: number, label: string): void {
  if (count > MAX_SOURCE_ITEMS) {
    throw new Error(`${label} exceeds the ${MAX_SOURCE_ITEMS} document safety limit.`);
  }
}

async function fetchJson<T>(params: {
  url: string;
  token: string;
  schema: z.ZodType<T>;
  label: string;
}): Promise<T> {
  const response = await fetch(params.url, {
    headers: { Authorization: `Bearer ${params.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  assertResponseOk(response, params.label);
  return params.schema.parse(await readProviderJsonResponse(response, params.label));
}

const graphItemSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    size: z.number().optional(),
    lastModifiedDateTime: z.string().optional(),
    file: z.object({ mimeType: z.string().optional() }).passthrough().optional(),
    deleted: z.object({}).passthrough().optional(),
    webUrl: z.string().optional(),
  })
  .passthrough();
const graphPageSchema = z
  .object({
    value: z.array(graphItemSchema),
    "@odata.nextLink": z.string().optional(),
    "@odata.deltaLink": z.string().optional(),
  })
  .passthrough();

function createMicrosoftAdapter(
  source: Extract<AgentBoxSourceConfig, { type: "microsoft-365" }>,
): AgentBoxSourceAdapter {
  const token = requireConfiguredSecret(source.accessTokenEnv);
  const fetchPage = async (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.origin !== "https://graph.microsoft.com") {
      throw new Error(`Microsoft 365 source ${source.id} returned an unsafe pagination URL.`);
    }
    const response = await fetch(parsed, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 410) {
      return { resetUrl: response.headers.get("location") };
    }
    assertResponseOk(response, `Microsoft 365 source ${source.id}`);
    return {
      page: graphPageSchema.parse(
        await readProviderJsonResponse(response, `Microsoft 365 source ${source.id}`),
      ),
    };
  };
  const read = async (itemId: string) => {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(source.driveId)}/items/${encodeURIComponent(itemId)}/content`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      },
    );
    assertResponseOk(response, `Microsoft 365 download ${itemId}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  return {
    id: source.id,
    async scan(cursor) {
      let next =
        cursor ||
        `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(source.driveId)}/root/delta`;
      const latest = new Map<string, z.infer<typeof graphItemSchema>>();
      let deltaLink;
      let resetAfterExpiredCursor = false;
      for (let page = 0; next && page < 10_000; page += 1) {
        const result = await fetchPage(next);
        if ("resetUrl" in result) {
          if (!result.resetUrl || resetAfterExpiredCursor) {
            throw new Error(`Microsoft 365 source ${source.id} returned an unusable delta reset.`);
          }
          next = result.resetUrl;
          resetAfterExpiredCursor = true;
          latest.clear();
          continue;
        }
        const payload = result.page;
        for (const item of payload.value) {
          latest.set(item.id, item);
        }
        assertItemLimit(latest.size, `Microsoft 365 source ${source.id}`);
        next = payload["@odata.nextLink"] ?? "";
        deltaLink = payload["@odata.deltaLink"] ?? deltaLink;
      }
      if (next) {
        throw new Error(`Microsoft 365 source ${source.id} exceeded its pagination limit.`);
      }
      const deletedKeys: string[] = [];
      const documents: AgentBoxDocument[] = [];
      for (const item of latest.values()) {
        const key = `${source.id}:${item.id}`;
        if (item.deleted) {
          deletedKeys.push(key);
          continue;
        }
        if (!item.file) {
          continue;
        }
        const modifiedAtMs = Date.parse(item.lastModifiedDateTime ?? "") || 0;
        const size = item.size ?? 0;
        documents.push({
          key,
          name: item.name || item.id,
          mimeType: item.file.mimeType,
          modifiedAtMs,
          size,
          fingerprint: `${modifiedAtMs}:${size}`,
          sourceUrl: item.webUrl,
          read: () => read(item.id),
        });
      }
      return {
        mode: cursor && !resetAfterExpiredCursor ? "delta" : "snapshot",
        documents,
        deletedKeys,
        cursor: deltaLink ?? cursor,
      };
    },
  };
}

const googleFileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    modifiedTime: z.string().optional(),
    size: z.string().optional(),
    trashed: z.boolean().optional(),
    webViewLink: z.string().optional(),
  })
  .passthrough();
const googleFilePageSchema = z
  .object({ files: z.array(googleFileSchema).default([]), nextPageToken: z.string().optional() })
  .passthrough();
const googleChangePageSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            fileId: z.string(),
            removed: z.boolean().optional(),
            file: googleFileSchema.optional(),
          })
          .passthrough(),
      )
      .default([]),
    nextPageToken: z.string().optional(),
    newStartPageToken: z.string().optional(),
  })
  .passthrough();
const googleStartTokenSchema = z.object({ startPageToken: z.string() }).passthrough();

function appendGoogleDriveParams(
  url: URL,
  driveId: string | undefined,
  options: { corpus?: boolean; includeItems?: boolean } = {},
): void {
  url.searchParams.set("supportsAllDrives", "true");
  if (driveId) {
    url.searchParams.set("driveId", driveId);
    if (options.corpus) {
      url.searchParams.set("corpora", "drive");
    }
    if (options.includeItems) {
      url.searchParams.set("includeItemsFromAllDrives", "true");
    }
  }
}

function createGoogleAdapter(
  source: Extract<AgentBoxSourceConfig, { type: "google-drive" }>,
): AgentBoxSourceAdapter {
  const token = requireConfiguredSecret(source.accessTokenEnv);
  const read = async (file: z.infer<typeof googleFileSchema>) => {
    const googleNative = file.mimeType.startsWith("application/vnd.google-apps.");
    const url = new URL(
      googleNative
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`,
    );
    if (googleNative) {
      url.searchParams.set("mimeType", "application/pdf");
    } else {
      url.searchParams.set("alt", "media");
      url.searchParams.set("supportsAllDrives", "true");
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
    assertResponseOk(response, `Google Drive download ${file.id}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const toDocument = (file: z.infer<typeof googleFileSchema>): AgentBoxDocument => {
    const modifiedAtMs = Date.parse(file.modifiedTime ?? "") || 0;
    const size = Number(file.size ?? 0);
    const googleNative = file.mimeType.startsWith("application/vnd.google-apps.");
    return {
      key: `${source.id}:${file.id}`,
      name:
        googleNative && !file.name.toLowerCase().endsWith(".pdf") ? `${file.name}.pdf` : file.name,
      mimeType: googleNative ? "application/pdf" : file.mimeType,
      modifiedAtMs,
      size,
      fingerprint: `${modifiedAtMs}:${size}:${file.mimeType}`,
      sourceUrl: file.webViewLink,
      read: () => read(file),
    };
  };
  return {
    id: source.id,
    async scan(cursor) {
      const documents: AgentBoxDocument[] = [];
      const deletedKeys: string[] = [];
      let nextPageToken;
      let nextCursor;
      if (!cursor) {
        do {
          const url = new URL("https://www.googleapis.com/drive/v3/files");
          url.searchParams.set("q", "trashed = false");
          url.searchParams.set(
            "fields",
            "nextPageToken,files(id,name,mimeType,modifiedTime,size,trashed,webViewLink)",
          );
          url.searchParams.set("pageSize", "1000");
          if (nextPageToken) {
            url.searchParams.set("pageToken", nextPageToken);
          }
          appendGoogleDriveParams(url, source.driveId, { corpus: true, includeItems: true });
          const page = await fetchJson({
            url: url.toString(),
            token,
            schema: googleFilePageSchema,
            label: `Google Drive source ${source.id}`,
          });
          documents.push(...page.files.filter((file) => !file.trashed).map(toDocument));
          assertItemLimit(documents.length, `Google Drive source ${source.id}`);
          nextPageToken = page.nextPageToken;
        } while (nextPageToken);
        const tokenUrl = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
        appendGoogleDriveParams(tokenUrl, source.driveId);
        const tokenPayload = await fetchJson({
          url: tokenUrl.toString(),
          token,
          schema: googleStartTokenSchema,
          label: `Google Drive source ${source.id}`,
        });
        nextCursor = tokenPayload.startPageToken;
      } else {
        nextPageToken = cursor;
        do {
          const url = new URL("https://www.googleapis.com/drive/v3/changes");
          url.searchParams.set("pageToken", nextPageToken);
          url.searchParams.set("pageSize", "1000");
          url.searchParams.set("includeRemoved", "true");
          url.searchParams.set(
            "fields",
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,trashed,webViewLink))",
          );
          appendGoogleDriveParams(url, source.driveId, { includeItems: true });
          const page = await fetchJson({
            url: url.toString(),
            token,
            schema: googleChangePageSchema,
            label: `Google Drive source ${source.id}`,
          });
          for (const change of page.changes) {
            if (change.removed || change.file?.trashed || !change.file) {
              deletedKeys.push(`${source.id}:${change.fileId}`);
            } else {
              documents.push(toDocument(change.file));
            }
          }
          assertItemLimit(
            documents.length + deletedKeys.length,
            `Google Drive source ${source.id}`,
          );
          nextPageToken = page.nextPageToken;
          nextCursor = page.newStartPageToken ?? nextCursor;
        } while (nextPageToken);
      }
      return {
        mode: cursor ? "delta" : "snapshot",
        documents,
        deletedKeys,
        cursor: nextCursor ?? cursor,
      };
    },
  };
}

async function walkLocalFiles(
  root: string,
): Promise<Array<{ absolute: string; relative: string }>> {
  const files: Array<{ absolute: string; relative: string }> = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (
        entry.isFile() &&
        SUPPORTED_LOCAL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push({ absolute, relative: path.relative(root, absolute).split(path.sep).join("/") });
        assertItemLimit(files.length, `Local source ${root}`);
      }
    }
  }
  return files;
}

function createLocalAdapter(
  source: Extract<AgentBoxSourceConfig, { type: "local" }>,
): AgentBoxSourceAdapter {
  return {
    id: source.id,
    async scan() {
      const documents = await Promise.all(
        (await walkLocalFiles(source.root)).map(async (file): Promise<AgentBoxDocument> => {
          const stat = await fs.stat(file.absolute);
          return {
            key: `${source.id}:${file.relative}`,
            name: path.basename(file.relative),
            modifiedAtMs: stat.mtimeMs,
            size: stat.size,
            fingerprint: `${stat.mtimeMs}:${stat.size}`,
            sourceUrl: `file://${file.relative}`,
            read: async () => new Uint8Array(await fs.readFile(file.absolute)),
          };
        }),
      );
      return { mode: "snapshot", documents, deletedKeys: [] };
    },
  };
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function readDavElement(block: string, localName: string): string | undefined {
  const match = block.match(
    new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`,
      "iu",
    ),
  );
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined;
}

export function parseWebDavMultiStatus(xml: string): Array<{
  href: string;
  collection: boolean;
  etag?: string;
  modifiedAtMs: number;
  size: number;
  mimeType?: string;
}> {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new Error("WebDAV response contains a forbidden document type or entity.");
  }
  const blocks =
    xml.match(
      /<(?:[A-Za-z_][\w.-]*:)?response\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?response>/giu,
    ) ?? [];
  return blocks.flatMap((block) => {
    const href = readDavElement(block, "href");
    if (!href) {
      return [];
    }
    return [
      {
        href,
        collection: /<(?:[A-Za-z_][\w.-]*:)?collection(?:\s[^>]*)?\/?\s*>/iu.test(block),
        etag: readDavElement(block, "getetag"),
        modifiedAtMs: Date.parse(readDavElement(block, "getlastmodified") ?? "") || 0,
        size: Number(readDavElement(block, "getcontentlength") ?? 0),
        mimeType: readDavElement(block, "getcontenttype"),
      },
    ];
  });
}

function createWebDavAdapter(
  source: Extract<AgentBoxSourceConfig, { type: "webdav" }>,
): AgentBoxSourceAdapter {
  const username = requireConfiguredSecret(source.usernameEnv);
  const password = requireConfiguredSecret(source.passwordEnv);
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const base = new URL(source.rootPath, `${source.baseUrl.replace(/\/$/u, "")}/`);
  const originPolicy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(base.toString());
  if (!originPolicy) {
    throw new Error(`WebDAV source ${source.id} has an invalid base URL.`);
  }
  const policy: SsrFPolicy = {
    ...originPolicy,
    allowPrivateNetwork: source.allowPrivateNetwork,
  };
  const request = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    const result = await fetchWithSsrFGuard({
      url,
      init: { ...init, headers },
      timeoutMs: 60_000,
      policy,
      auditContext: `agentbox.webdav.${source.id}`,
    });
    return result;
  };
  return {
    id: source.id,
    async scan() {
      const documents: AgentBoxDocument[] = [];
      const pending = [base.toString()];
      const seenCollections = new Set<string>();
      while (pending.length > 0) {
        const collectionUrl = pending.pop();
        if (!collectionUrl || seenCollections.has(collectionUrl)) {
          continue;
        }
        seenCollections.add(collectionUrl);
        const { response, release } = await request(collectionUrl, {
          method: "PROPFIND",
          headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
          body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>',
        });
        let entries;
        try {
          if (response.status !== 207) {
            throw new Error(`WebDAV PROPFIND failed (${response.status} ${response.statusText})`);
          }
          const xml = await response.text();
          if (xml.length > 16 * 1024 * 1024) {
            throw new Error("WebDAV response exceeds the 16 MiB safety limit.");
          }
          entries = parseWebDavMultiStatus(xml);
        } finally {
          await release();
        }
        for (const entry of entries) {
          const url = new URL(entry.href, collectionUrl);
          if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
            throw new Error(`WebDAV source ${source.id} returned an out-of-scope href.`);
          }
          const href = url.toString();
          if (
            href === collectionUrl ||
            href.replace(/\/$/u, "") === base.toString().replace(/\/$/u, "")
          ) {
            continue;
          }
          if (entry.collection) {
            pending.push(href);
            continue;
          }
          const relative = decodeURIComponent(url.pathname.slice(base.pathname.length)).replace(
            /^\/+/u,
            "",
          );
          documents.push({
            key: `${source.id}:${relative}`,
            name: path.posix.basename(relative),
            mimeType: entry.mimeType,
            modifiedAtMs: entry.modifiedAtMs,
            size: entry.size,
            fingerprint: entry.etag || `${entry.modifiedAtMs}:${entry.size}`,
            sourceUrl: href,
            read: async () => {
              const result = await request(href, { method: "GET" });
              try {
                assertResponseOk(result.response, `WebDAV download ${relative}`);
                return new Uint8Array(await result.response.arrayBuffer());
              } finally {
                await result.release();
              }
            },
          });
          assertItemLimit(documents.length, `WebDAV source ${source.id}`);
        }
      }
      return { mode: "snapshot", documents, deletedKeys: [] };
    },
  };
}

export function createSourceAdapter(source: AgentBoxSourceConfig): AgentBoxSourceAdapter {
  switch (source.type) {
    case "google-drive":
      return createGoogleAdapter(source);
    case "local":
      return createLocalAdapter(source);
    case "microsoft-365":
      return createMicrosoftAdapter(source);
    case "webdav":
      return createWebDavAdapter(source);
  }
  throw new Error("Unsupported AgentBox source type.");
}
