import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { MemoryItem } from "../memory/memoryItem";
import { documentClient } from "./documentClient";

function buildWorkspacePk(workspaceId: string): string {
  return `WORKSPACE#${workspaceId}`;
}

function buildMemorySk(memoryId: string): string {
  return `MEMORY#${memoryId}`;
}

function buildEntityGsiPk(workspaceId: string, entityKey: string): string {
  return `WORKSPACE#${workspaceId}#ENTITY#${entityKey}`;
}

function buildEntityGsiSk(updatedAt: string, memoryId: string): string {
  return `UPDATED#${updatedAt}#MEMORY#${memoryId}`;
}

export class MemoryItemRepository {
  constructor(private readonly tableName: string) {}

  async save(item: Omit<MemoryItem, "memoryId" | "createdAt" | "updatedAt"> & { memoryId?: string }): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const record: MemoryItem = {
      ...item,
      memoryId: item.memoryId ?? `mem_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(record.workspaceId),
          sk: buildMemorySk(record.memoryId),
          gsi1pk: record.entityKey
            ? buildEntityGsiPk(record.workspaceId, record.entityKey)
            : undefined,
          gsi1sk: record.entityKey ? buildEntityGsiSk(record.updatedAt, record.memoryId) : undefined,
          memoryId: record.memoryId,
          workspaceId: record.workspaceId,
          entityKey: record.entityKey,
          text: record.text,
          searchText: buildSearchText(record.text, record.attributes, record.tags),
          attributes: record.attributes,
          tags: record.tags,
          importance: record.importance,
          sourceType: record.sourceType,
          sourceRef: record.sourceRef,
          createdByUserId: record.createdByUserId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async search(input: {
    workspaceId: string;
    query: string;
    entityKey?: string;
    limit?: number;
  }): Promise<MemoryItem[]> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        ...(input.entityKey
          ? {
              IndexName: "EntityIndex",
              KeyConditionExpression: "gsi1pk = :gsi1pk",
              ExpressionAttributeValues: {
                ":gsi1pk": buildEntityGsiPk(input.workspaceId, input.entityKey),
              },
            }
          : {
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: {
                ":pk": buildWorkspacePk(input.workspaceId),
              },
            }),
        ScanIndexForward: false,
        Limit: 100,
      }),
    );

    const terms = normalize(input.query)
      .split(/\s+/)
      .filter(Boolean);

    const items = (response.Items ?? [])
      .map((item) => ({
        workspaceId: item.workspaceId,
        memoryId: item.memoryId,
        entityKey: item.entityKey,
        text: item.text,
        attributes: item.attributes,
        tags: item.tags,
        importance: item.importance,
        sourceType: item.sourceType,
        sourceRef: item.sourceRef,
        createdByUserId: item.createdByUserId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        searchText: item.searchText as string | undefined,
      }))
      .filter((item) => matchesSearch(item.searchText ?? "", terms))
      .sort((a, b) => {
        const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
        if (importanceDiff !== 0) {
          return importanceDiff;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit)
      .map(({ searchText: _searchText, ...item }) => item);

    return items;
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function buildSearchText(
  text: string,
  attributes?: Record<string, unknown>,
  tags?: string[],
): string {
  return normalize(
    [text, JSON.stringify(attributes ?? {}), (tags ?? []).join(" ")]
      .filter(Boolean)
      .join(" "),
  );
}

function matchesSearch(searchText: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }

  return terms.every((term) => searchText.includes(term));
}
