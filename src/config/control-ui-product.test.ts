import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("managed Control UI product configuration", () => {
  it("accepts AgentBox branding and automatic role-based navigation", () => {
    const result = validateConfigObject({
      gateway: {
        controlUi: {
          product: {
            name: "AlpenData AgentBox",
            shortName: "AgentBox",
            logoPath: "/agentbox-logo.svg",
            faviconPath: "/agentbox-favicon.svg",
            docsUrl: "https://www.alpendata.ch/agentbox/docs",
            supportUrl: "https://www.alpendata.ch/contact",
            privacyUrl: "https://www.alpendata.ch/privacy",
          },
          shellProfile: "auto",
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.gateway?.controlUi?.product?.name).toBe("AlpenData AgentBox");
      expect(result.data.gateway?.controlUi?.shellProfile).toBe("auto");
    }
  });

  it("rejects external product asset paths and insecure public links", () => {
    const result = validateConfigObject({
      gateway: {
        controlUi: {
          product: {
            name: "AgentBox",
            logoPath: "https://tracker.example/logo.svg",
            supportUrl: "not-a-url",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
  });
});
