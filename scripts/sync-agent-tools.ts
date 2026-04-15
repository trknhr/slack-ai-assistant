import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SecretsProvider } from "../src/aws/secretsProvider";

interface CustomToolDefinition {
  type: "custom";
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface AgentToolset {
  type: "agent_toolset_20260401";
  configs?: Array<{
    name: "bash" | "edit" | "read" | "write" | "glob" | "grep" | "web_fetch" | "web_search";
    enabled?: boolean;
    permission_policy?: { type: "always_allow" | "always_ask" };
  }>;
  default_config?: {
    enabled?: boolean;
    permission_policy?: { type: "always_allow" | "always_ask" };
  };
}

type BuiltInToolName =
  | "bash"
  | "edit"
  | "read"
  | "write"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search";

interface MCPToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  configs?: Array<{
    name: string;
    enabled?: boolean;
    permission_policy?: { type: "always_allow" | "always_ask" };
  }>;
  default_config?: {
    enabled?: boolean;
    permission_policy?: { type: "always_allow" | "always_ask" };
  };
}

type SupportedTool = CustomToolDefinition | AgentToolset | MCPToolset;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agentId = args["agent-id"] ?? process.env.ANTHROPIC_AGENT_ID;
  if (!agentId) {
    throw new Error("Missing agent id. Pass --agent-id=agent_... or set ANTHROPIC_AGENT_ID.");
  }

  const toolsFile = resolve(
    process.cwd(),
    args["tools-file"] ??
      process.env.ANTHROPIC_CUSTOM_TOOLS_FILE ??
      "src/tools/anthropic-custom-tools.json",
  );
  const beta = args.beta ?? process.env.ANTHROPIC_MANAGED_AGENTS_BETA ?? "managed-agents-2026-04-01";
  const apiKey = await resolveApiKey(args["api-key-secret-id"] ?? process.env.ANTHROPIC_API_KEY_SECRET_ID);
  const client = new Anthropic({ apiKey });

  const definitions = await loadDefinitions(toolsFile);
  const definitionNames = new Set(definitions.map((definition) => definition.name));
  const agent = await client.beta.agents.retrieve(agentId, { betas: [beta as never] });

  const mergedTools: SupportedTool[] = [
    ...(agent.tools as unknown[])
      .filter((tool): tool is Record<string, unknown> => isRecord(tool))
      .filter((tool) => tool.type !== "custom" || !definitionNames.has(String(tool.name)))
      .map(normalizeToolForUpdate),
    ...definitions,
  ];

  if (args["dry-run"] === "true") {
    console.log(
      JSON.stringify(
        {
          agentId,
          currentVersion: agent.version,
          mergedTools,
        },
        null,
        2,
      ),
    );
    return;
  }

  const updated = await client.beta.agents.update(
    agentId,
    {
      version: agent.version,
      tools: mergedTools as never,
      metadata: {
        synced_custom_tools_at: new Date().toISOString(),
      },
      betas: [beta as never],
    },
  );

  const syncedNames = mergedTools
    .filter((tool): tool is CustomToolDefinition => tool.type === "custom")
    .map((tool) => tool.name);

  console.log(
    JSON.stringify(
      {
        ok: true,
        agentId: updated.id,
        version: updated.version,
        syncedCustomTools: syncedNames,
        toolsFile,
      },
      null,
      2,
    ),
  );
}

async function resolveApiKey(secretIdOverride?: string): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }

  const secretsProvider = new SecretsProvider();
  const secretId = secretIdOverride ?? "/slack-ai-assistant/anthropic-api-key";
  return secretsProvider.getSecretString(secretId);
}

async function loadDefinitions(filePath: string): Promise<CustomToolDefinition[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Custom tool definition file must contain an array: ${filePath}`);
  }

  const definitions = parsed.map(assertCustomToolDefinition);
  if (definitions.length === 0) {
    throw new Error(`Custom tool definition file is empty: ${filePath}`);
  }

  return definitions;
}

function assertCustomToolDefinition(value: unknown): CustomToolDefinition {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid custom tool definition: expected object");
  }

  const record = value as Record<string, unknown>;
  if (record.type !== "custom") {
    throw new Error(`Invalid custom tool type: ${String(record.type)}`);
  }
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error("Invalid custom tool definition: missing name");
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    throw new Error(`Invalid custom tool definition for ${record.name}: missing description`);
  }
  if (!record.input_schema || typeof record.input_schema !== "object") {
    throw new Error(`Invalid custom tool definition for ${record.name}: missing input_schema`);
  }

  return {
    type: "custom",
    name: record.name,
    description: record.description,
    input_schema: record.input_schema as CustomToolDefinition["input_schema"],
  };
}

function normalizeToolForUpdate(tool: unknown): SupportedTool {
  if (!isRecord(tool)) {
    throw new Error("Unsupported agent tool payload");
  }

  switch (tool.type) {
    case "custom":
      return {
        type: "custom",
        name: tool.name as string,
        description: tool.description as string,
        input_schema: tool.input_schema as CustomToolDefinition["input_schema"],
      };
    case "agent_toolset_20260401":
      return {
        type: "agent_toolset_20260401",
        configs: Array.isArray(tool.configs)
          ? tool.configs.map((config) => ({
              name: String((config as Record<string, unknown>).name) as BuiltInToolName,
              enabled: readBooleanField(config, "enabled"),
              permission_policy: readPolicyField(config, "permission_policy"),
            }))
          : undefined,
        default_config: isRecord(tool.default_config)
          ? {
              enabled: readBooleanField(tool.default_config, "enabled"),
              permission_policy: readPolicyField(tool.default_config, "permission_policy"),
            }
          : undefined,
      };
    case "mcp_toolset":
      return {
        type: "mcp_toolset",
        mcp_server_name: tool.mcp_server_name as string,
        configs: Array.isArray(tool.configs)
          ? tool.configs.map((config) => ({
              name: String((config as Record<string, unknown>).name),
              enabled: readBooleanField(config, "enabled"),
              permission_policy: readPolicyField(config, "permission_policy"),
            }))
          : undefined,
        default_config: isRecord(tool.default_config)
          ? {
              enabled: readBooleanField(tool.default_config, "enabled"),
              permission_policy: readPolicyField(tool.default_config, "permission_policy"),
            }
          : undefined,
      };
    default:
      throw new Error(`Unsupported agent tool type: ${String(tool.type)}`);
  }
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function readObjectField(value: unknown, key: string): { type: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  if (!isRecord(field) || typeof field.type !== "string") {
    return undefined;
  }
  return { type: field.type };
}

function readPolicyField(
  value: unknown,
  key: string,
): { type: "always_allow" | "always_ask" } | undefined {
  const field = readObjectField(value, key);
  if (!field || (field.type !== "always_allow" && field.type !== "always_ask")) {
    return undefined;
  }
  return field as { type: "always_allow" | "always_ask" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, value] = arg.slice(2).split("=", 2);
    parsed[key] = value ?? "true";
  }

  return parsed;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exitCode = 1;
});
