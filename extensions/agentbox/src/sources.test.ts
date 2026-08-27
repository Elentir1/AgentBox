import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceAdapter, parseWebDavMultiStatus } from "./sources.js";

const temporaryDirectories: string[] = [];

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.AGENTBOX_GRAPH_TOKEN;
  delete process.env.AGENTBOX_GOOGLE_TOKEN;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentBox document sources", () => {
  it("enumerates supported local business documents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-local-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "finance"));
    await fs.writeFile(path.join(root, "finance", "invoice.pdf"), "pdf");
    await fs.writeFile(path.join(root, "ignore.exe"), "binary");

    const scan = await createSourceAdapter({ id: "local", type: "local", root }).scan();

    expect(scan.mode).toBe("snapshot");
    expect(scan.documents.map((document) => document.key)).toEqual(["local:finance/invoice.pdf"]);
    await expect(scan.documents[0]?.read()).resolves.toEqual(new Uint8Array(Buffer.from("pdf")));
  });

  it("follows Microsoft Graph delta pages and exposes downloadable files", async () => {
    process.env.AGENTBOX_GRAPH_TOKEN = "token";
    const requests: Array<{ url: string; authorization?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        });
        if (url.endsWith("/content")) {
          return new Response("document");
        }
        return Response.json({
          value: [
            {
              id: "item-1",
              name: "policy.docx",
              size: 8,
              lastModifiedDateTime: "2026-08-27T10:00:00Z",
              file: {
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              },
              webUrl: "https://tenant.sharepoint.com/policy.docx",
            },
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive/root/delta?token=next",
        });
      }),
    );

    const scan = await createSourceAdapter({
      id: "sharepoint",
      type: "microsoft-365",
      driveId: "drive",
      accessTokenEnv: "AGENTBOX_GRAPH_TOKEN",
    }).scan();

    expect(scan.cursor).toContain("token=next");
    expect(scan.documents[0]).toMatchObject({
      key: "sharepoint:item-1",
      name: "policy.docx",
    });
    await expect(scan.documents[0]?.read()).resolves.toEqual(
      new Uint8Array(Buffer.from("document")),
    );
    expect(requests.every((request) => request.authorization === "Bearer token")).toBe(true);
  });

  it("captures Google Drive files before storing the changes cursor", async () => {
    process.env.AGENTBOX_GOOGLE_TOKEN = "token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("startPageToken")) {
          return Response.json({ startPageToken: "cursor-2" });
        }
        return Response.json({
          files: [
            {
              id: "sheet-1",
              name: "Budget",
              mimeType: "application/vnd.google-apps.spreadsheet",
              modifiedTime: "2026-08-27T10:00:00Z",
              webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1",
            },
          ],
        });
      }),
    );

    const scan = await createSourceAdapter({
      id: "drive",
      type: "google-drive",
      driveId: "shared-drive",
      accessTokenEnv: "AGENTBOX_GOOGLE_TOKEN",
    }).scan();

    expect(scan.mode).toBe("snapshot");
    expect(scan.cursor).toBe("cursor-2");
    expect(scan.documents[0]).toMatchObject({
      key: "drive:sheet-1",
      name: "Budget.pdf",
      mimeType: "application/pdf",
    });
  });

  it("parses namespace-qualified WebDAV metadata without processing entities", () => {
    const xml = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/remote.php/dav/files/acme/report.pdf</d:href>
          <d:propstat><d:prop>
            <d:getetag>&quot;v1&quot;</d:getetag>
            <d:getcontentlength>42</d:getcontentlength>
            <d:getlastmodified>Thu, 27 Aug 2026 10:00:00 GMT</d:getlastmodified>
            <d:getcontenttype>application/pdf</d:getcontenttype>
          </d:prop></d:propstat>
        </d:response>
      </d:multistatus>`;

    expect(parseWebDavMultiStatus(xml)).toEqual([
      expect.objectContaining({
        href: "/remote.php/dav/files/acme/report.pdf",
        collection: false,
        etag: '"v1"',
        size: 42,
        mimeType: "application/pdf",
      }),
    ]);
    expect(() =>
      parseWebDavMultiStatus("<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]>"),
    ).toThrow("forbidden");
  });
});
