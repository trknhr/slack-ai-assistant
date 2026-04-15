import { AnthropicManagedAgentsClient } from "./client";

export interface SessionMemoryResource {
  memoryStoreId: string;
  access?: "read_only" | "read_write";
  prompt?: string;
}

export interface CreateSessionInput {
  agentId: string;
  environmentId: string;
  vaultIds?: string[];
  title?: string;
  metadata?: Record<string, string>;
  memoryResources?: SessionMemoryResource[];
}

export interface CreateSessionResult {
  id: string;
  status?: string;
}

export async function createSession(
  client: AnthropicManagedAgentsClient,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  return client.request<CreateSessionResult>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: input.agentId,
      environment_id: input.environmentId,
      vault_ids: input.vaultIds,
      title: input.title,
      metadata: input.metadata,
      resources: input.memoryResources?.map((resource) => ({
        type: "memory_store",
        memory_store_id: resource.memoryStoreId,
        access: resource.access ?? "read_write",
        prompt: resource.prompt,
      })),
    }),
  });
}
