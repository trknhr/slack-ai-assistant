import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { UserPreferenceItem } from "../memory/userPreferenceItem";
import { documentClient } from "./documentClient";

function buildUserPk(workspaceId: string, userId: string): string {
  return `USER#${workspaceId}#${userId}`;
}

function buildPreferenceSk(preferenceId: string): string {
  return `PREFERENCE#${preferenceId}`;
}

export class UserPreferenceRepository {
  constructor(private readonly tableName: string) {}

  async save(
    item: Omit<UserPreferenceItem, "preferenceId" | "createdAt" | "updatedAt"> & {
      preferenceId?: string;
    },
  ): Promise<UserPreferenceItem> {
    const now = new Date().toISOString();
    const record: UserPreferenceItem = {
      ...item,
      preferenceId: item.preferenceId ?? `pref_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildUserPk(record.workspaceId, record.userId),
          sk: buildPreferenceSk(record.preferenceId),
          workspaceId: record.workspaceId,
          userId: record.userId,
          preferenceId: record.preferenceId,
          preferenceKey: record.preferenceKey,
          entityKey: record.entityKey,
          text: record.text,
          searchText: buildSearchText(record.text, record.attributes, record.tags),
          attributes: record.attributes,
          tags: record.tags,
          importance: record.importance,
          origin: record.origin,
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
    userId: string;
    query: string;
    entityKey?: string;
    limit?: number;
  }): Promise<UserPreferenceItem[]> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": buildUserPk(input.workspaceId, input.userId),
        },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );

    const terms = normalize(input.query)
      .split(/\s+/)
      .filter(Boolean);

    return (response.Items ?? [])
      .map((item) => ({
        workspaceId: item.workspaceId,
        userId: item.userId,
        preferenceId: item.preferenceId,
        preferenceKey: item.preferenceKey,
        entityKey: item.entityKey,
        text: item.text,
        attributes: item.attributes,
        tags: item.tags,
        importance: item.importance,
        origin: item.origin,
        sourceType: item.sourceType,
        sourceRef: item.sourceRef,
        createdByUserId: item.createdByUserId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        searchText: item.searchText as string | undefined,
      }))
      .filter((item) => !input.entityKey || item.entityKey === input.entityKey)
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
