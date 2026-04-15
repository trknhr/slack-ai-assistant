import { AnthropicManagedAgentsClient } from "../claude/client";
import { UserMemoryRepository } from "../repo/userMemoryRepository";
import { UserMemoryRecord } from "../shared/contracts";

export interface GetOrCreateMemoryStoreInput {
  workspaceId: string;
  userId: string;
}

export class MemoryStoreService {
  constructor(
    private readonly userMemoryRepository: UserMemoryRepository,
    private readonly claudeClient: AnthropicManagedAgentsClient,
  ) {}

  async getOrCreateMemoryStore(
    input: GetOrCreateMemoryStoreInput,
  ): Promise<UserMemoryRecord> {
    const existing = await this.userMemoryRepository.find(input.workspaceId, input.userId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const store = await this.claudeClient.createMemoryStore({
      name: `workspace-${input.workspaceId}-user-${input.userId}`,
      description: "Per-user preferences and durable project context.",
    });

    const record: UserMemoryRecord = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      memoryStoreId: store.id,
      createdAt: now,
      updatedAt: now,
    };

    await this.userMemoryRepository.save(record);
    return record;
  }
}
