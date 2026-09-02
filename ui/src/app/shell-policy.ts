import { APP_ROUTE_IDS, type RouteId } from "../app-routes.ts";

const EMPLOYEE_ROUTE_IDS = [
  "chat",
  "overview",
  "sessions",
  "plugin",
] as const satisfies readonly RouteId[];

export type ControlUiShellProfile = "auto" | "employee" | "full";

export function resolveShellProfile(
  configured: ControlUiShellProfile,
  hasAdminScope: boolean,
): "employee" | "full" {
  return configured === "auto" ? (hasAdminScope ? "full" : "employee") : configured;
}

export function enabledRoutesForShell(params: {
  profile: "employee" | "full";
  workboardEnabled: boolean;
}): readonly RouteId[] {
  const routes =
    params.profile === "employee" ? EMPLOYEE_ROUTE_IDS : (APP_ROUTE_IDS as readonly RouteId[]);
  return params.workboardEnabled ? routes : routes.filter((routeId) => routeId !== "workboard");
}

export function isRouteEnabledForShell(
  routeId: RouteId,
  enabledRouteIds: readonly RouteId[],
): boolean {
  return enabledRouteIds.includes(routeId);
}
