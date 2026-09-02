import {
  DEFAULT_CONTROL_UI_PRODUCT_BRANDING,
  type ControlUiProductBranding,
} from "../../../src/gateway/control-ui-contract.js";
import { controlUiPublicAssetPath, type ControlUiPublicAsset } from "./public-assets.ts";

export type ProductBranding = ControlUiProductBranding;

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeSameOriginPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }
  return value;
}

function normalizePublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeProductBranding(value: unknown): ProductBranding {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const name = normalizeText(record.name, DEFAULT_CONTROL_UI_PRODUCT_BRANDING.name);
  return {
    name,
    shortName: normalizeText(record.shortName, name),
    logoPath: normalizeSameOriginPath(record.logoPath),
    faviconPath: normalizeSameOriginPath(record.faviconPath),
    docsUrl: normalizePublicUrl(record.docsUrl) ?? DEFAULT_CONTROL_UI_PRODUCT_BRANDING.docsUrl,
    supportUrl:
      normalizePublicUrl(record.supportUrl) ?? DEFAULT_CONTROL_UI_PRODUCT_BRANDING.supportUrl,
    privacyUrl:
      normalizePublicUrl(record.privacyUrl) ?? DEFAULT_CONTROL_UI_PRODUCT_BRANDING.privacyUrl,
  };
}

export function applyProductBranding(branding: ProductBranding): void {
  if (typeof document === "undefined") {
    return;
  }
  document.title = branding.name;
  document.documentElement.dataset.productName = branding.name;
  if (!branding.faviconPath) {
    return;
  }
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    link.href = branding.faviconPath;
  }
}

export function productAssetPath(
  configuredPath: string | undefined,
  fallbackAsset: ControlUiPublicAsset,
  basePath: string,
): string {
  return configuredPath ?? controlUiPublicAssetPath(fallbackAsset, basePath);
}
