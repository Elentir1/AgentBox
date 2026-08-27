import { afterEach, describe, expect, it } from "vitest";
import {
  applyProductBranding,
  normalizeProductBranding,
  productAssetPath,
} from "./product-branding.ts";

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-product-name");
});

describe("AgentBox product branding", () => {
  it("uses AlpenData defaults and rejects unsafe asset paths", () => {
    expect(
      normalizeProductBranding({
        name: "  Customer AgentBox ",
        faviconPath: "https://tracker.example/favicon.svg",
        supportUrl: "http://insecure.example",
      }),
    ).toMatchObject({
      name: "Customer AgentBox",
      shortName: "Customer AgentBox",
      faviconPath: undefined,
      supportUrl: "https://www.alpendata.ch/contact",
    });
  });

  it("applies the title and same-origin favicon", () => {
    document.head.innerHTML = '<link rel="icon" href="/old.svg">';
    const branding = normalizeProductBranding({
      name: "AlpenData AgentBox",
      faviconPath: "/agentbox-favicon.svg",
    });

    applyProductBranding(branding);

    expect(document.title).toBe("AlpenData AgentBox");
    expect(document.documentElement.dataset.productName).toBe("AlpenData AgentBox");
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute("href")).toBe(
      "/agentbox-favicon.svg",
    );
  });

  it("resolves bundled assets under the configured base path", () => {
    expect(productAssetPath(undefined, "agentbox-logo.svg", "/console")).toBe(
      "/console/agentbox-logo.svg",
    );
  });
});
