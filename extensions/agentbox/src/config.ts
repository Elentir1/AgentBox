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
    accessTokenEnv: envNameSchema,
  })
  .strict();

const googleSourceSchema = z
  .object({
    id: sourceIdSchema,
    type: z.literal("google-drive"),
    driveId: z.string().min(1).optional(),
    accessTokenEnv: envNameSchema,
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

const agentBoxConfigObject = z
  .object({
    tenantId: sourceIdSchema,
    backend: z
      .object({
        baseUrl: z.url(),
        datasetId: z.string().min(1),
        apiKeyEnv: envNameSchema,
        allowPrivateNetwork: z.boolean().default(false),
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
  .strict();

export type AgentBoxConfig = z.infer<typeof agentBoxConfigObject>;
export type AgentBoxSourceConfig = AgentBoxConfig["sources"][number];

export const agentBoxConfigSchema: OpenClawPluginConfigSchema = buildPluginConfigSchema({
  safeParse(value) {
    const parsed = agentBoxConfigObject.safeParse(value);
    if (parsed.success) {
      return { success: true, data: parsed.data };
    }
    return { success: false, error: { issues: mapPluginConfigIssues(parsed.error.issues) } };
  },
  jsonSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
    },
  },
});

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
