export interface MemoryItem {
  workspaceId: string;
  memoryId: string;
  entityKey?: string;
  text: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
  importance?: number;
  sourceType?: string;
  sourceRef?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}
