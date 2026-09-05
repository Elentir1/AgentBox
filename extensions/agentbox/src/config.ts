import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]+$/u);
const sourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u);

const localSourceSchema = z
  .object({
    id: sourceIdSchema,
    type: z.literal("local"),
    root: z.string().min(1),
  })
  .strict();

const microsoftSourceSchema = z
  .object({
    id: sourceIdSchema,
    type: z.literal("microsoft-365"),
    driveId: z.string().min(1),
    entraTenantIdEnv: envNameSchema,
    clientIdEnv: envNameSchema,
    clientSecretEnv: envNameSchema,
  })
  .strict();

const googleSourceSchema = z
  .object({
    id: sourceIdSchema,
    type: z.literal("google-drive"),
    driveId: z.string().min(1).optional(),
    clientIdEnv: envNameSchema,
    clientSecretEnv: envNameSchema,
    refreshTokenEnv: envNameSchema,
  })
  .strict();

const webDavSourceSchema = z
  .object({
    id: sourceIdSchema,
    type: z.literal("webdav"),
    baseUrl: z.url().refine((value) => value.startsWith("https://"), "WebDAV requires HTTPS"),
    rootPath: z.string().min(1).default("/"),
    usernameEnv: envNameSchema,
    passwordEnv: envNameSchema,
    allowPrivateNetwork: z.boolean().default(false),
  })
  .strict();

// Quota ceilings mirror deploy/agentbox/tenant-manifest.schema.json. maxDocuments
// cannot exceed the document index capacity in state.ts, so no plan may sell more.
const entitlementsSchema = z
  .object({
    planId: sourceIdSchema,
    status: z.enum(["active", "grace", "suspended"]),
    validUntil: z.iso.datetime().optional(),
    quotas: z
      .object({
        maxSources: z.number().int().min(1).max(50),
        maxDocuments: z.number().int().min(1).max(50_000),
        maxStorageBytes: z
          .number()
          .int()
          .min(1024 * 1024),
        minSyncIntervalMinutes: z.number().int().min(1).max(1440),
      })
      .strict(),
  })
  .strict();

const agentBoxConfigObject = z
  .object({
    tenantId: sourceIdSchema,
    entitlements: entitlementsSchema,
    index: z
      .object({
        embedding: z
          .object({
            baseUrl: z.url(),
            model: z.string().min(1),
            apiKeyEnv: envNameSchema,
            dimensions: z.number().int().min(1).optional(),
            allowPrivateNetwork: z.boolean().default(false),
          })
          .strict(),
        chunk: z
          .object({
            maxCharacters: z.number().int().min(200).max(8000).default(1500),
            overlapCharacters: z.number().int().min(0).max(2000).default(200),
          })
          .strict()
          .default({ maxCharacters: 1500, overlapCharacters: 200 }),
        minSimilarity: z.number().min(0).max(1).default(0.15),
      })
      .strict(),
    sync: z
      .object({
        intervalMinutes: z.number().int().min(1).max(1440).default(15),
        maxFileBytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024 * 1024)
          .default(100 * 1024 * 1024),
      })
      .strict()
      .default({ intervalMinutes: 15, maxFileBytes: 100 * 1024 * 1024 }),
    sources: z
      .array(
        z.discriminatedUnion("type", [
          googleSourceSchema,
          localSourceSchema,
          microsoftSourceSchema,
          webDavSourceSchema,
        ]),
      )
      .min(1)
      .refine(
        (sources) => new Set(sources.map((source) => source.id)).size === sources.length,
        "Source ids must be unique",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const embedding = value.index.embedding;
    if (embedding.baseUrl.startsWith("http://") && !embedding.allowPrivateNetwork) {
      ctx.addIssue({
        code: "custom",
        message: "HTTP embedding endpoints require allowPrivateNetwork: true",
        path: ["index", "embedding", "allowPrivateNetwork"],
      });
    }
    if (value.index.chunk.overlapCharacters >= value.index.chunk.maxCharacters) {
      ctx.addIssue({
        code: "custom",
        message: "Chunk overlap must be smaller than the chunk size",
        path: ["index", "chunk", "overlapCharacters"],
      });
    }
    const quotas = value.entitlements.quotas;
    // Source count and sync cadence are plan limits the runtime can decide before
    // it touches a customer document, so they fail configuration instead of a scan.
    if (value.sources.length > quotas.maxSources) {
      ctx.addIssue({
        code: "custom",
        message: `Plan ${value.entitlements.planId} allows ${quotas.maxSources} document sources, but ${value.sources.length} are configured`,
        path: ["sources"],
      });
    }
    if (value.sync.intervalMinutes < quotas.minSyncIntervalMinutes) {
      ctx.addIssue({
        code: "custom",
        message: `Plan ${value.entitlements.planId} allows a sync interval of ${quotas.minSyncIntervalMinutes} minutes at the fastest`,
        path: ["sync", "intervalMinutes"],
      });
    }
  });

export type AgentBoxConfig = z.infer<typeof agentBoxConfigObject>;
export type AgentBoxSourceConfig = AgentBoxConfig["sources"][number];
export type AgentBoxEntitlements = AgentBoxConfig["entitlements"];

export const agentBoxConfigSchema: OpenClawPluginConfigSchema = buildPluginConfigSchema(
  agentBoxConfigObject,
  {
    safeParse(value) {
      const parsed = agentBoxConfigObject.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, error: { issues: mapPluginConfigIssues(parsed.error.issues) } };
    },
  },
);

export function resolveAgentBoxConfig(value: unknown): AgentBoxConfig {
  return agentBoxConfigObject.parse(value);
}

export function requireConfiguredSecret(envName: string): string {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`AgentBox requires the ${envName} environment variable.`);
  }
  return value;
}
