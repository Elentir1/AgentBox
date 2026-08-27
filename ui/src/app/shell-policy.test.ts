import { describe, expect, it } from "vitest";
import {
  enabledRoutesForShell,
  isRouteEnabledForShell,
  resolveShellProfile,
} from "./shell-policy.ts";

describe("AgentBox shell policy", () => {
  it("keeps employee navigation focused on document conversations", () => {
    const routes = enabledRoutesForShell({ profile: "employee", workboardEnabled: true });

    expect(routes).toEqual(["chat", "overview", "sessions", "plugin"]);
    expect(isRouteEnabledForShell("config", routes)).toBe(false);
    expect(isRouteEnabledForShell("chat", routes)).toBe(true);
  });

  it("preserves the full operator console while honoring feature gates", () => {
    const routes = enabledRoutesForShell({ profile: "full", workboardEnabled: false });

    expect(routes).toContain("config");
    expect(routes).not.toContain("workboard");
  });

  it("derives managed roles from the authenticated operator scope", () => {
    expect(resolveShellProfile("auto", false)).toBe("employee");
    expect(resolveShellProfile("auto", true)).toBe("full");
  });
});
