import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CalendarDraft, CalendarDraftStatus } from "../calendar/calendarDraft";
import { documentClient } from "./documentClient";

function buildDraftPk(workspaceId: string, userId?: string): string {
  return `WORKSPACE#${workspaceId}#USER#${userId ?? "_"}`;
}

function buildDraftSk(draftId: string): string {
  return `DRAFT#${draftId}`;
}

export class CalendarDraftRepository {
  constructor(private readonly tableName: string) {}

  async save(draft: CalendarDraft): Promise<CalendarDraft> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildDraftPk(draft.workspaceId, draft.userId),
          sk: buildDraftSk(draft.draftId),
          draftId: draft.draftId,
          workspaceId: draft.workspaceId,
          userId: draft.userId,
          title: draft.title,
          notes: draft.notes,
          sourceId: draft.sourceId,
          sourceRef: draft.sourceRef,
          calendarId: draft.calendarId,
          status: draft.status,
          candidates: draft.candidates,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
          approvedAt: draft.approvedAt,
          rejectedAt: draft.rejectedAt,
          lastAppliedAt: draft.lastAppliedAt,
        },
      }),
    );

    return draft;
  }

  async get(workspaceId: string, userId: string | undefined, draftId: string): Promise<CalendarDraft | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildDraftPk(workspaceId, userId),
          sk: buildDraftSk(draftId),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return mapCalendarDraft(response.Item);
  }

  async list(input: {
    workspaceId: string;
    userId?: string;
    statuses?: CalendarDraftStatus[];
    limit?: number;
  }): Promise<CalendarDraft[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": buildDraftPk(input.workspaceId, input.userId),
        },
        Limit: 50,
      }),
    );

    const drafts = (response.Items ?? []).map(mapCalendarDraft);
    const filtered =
      input.statuses && input.statuses.length > 0
        ? drafts.filter((draft) => input.statuses!.includes(draft.status))
        : drafts;

    return filtered
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(Math.max(input.limit ?? 10, 1), 20));
  }
}

function mapCalendarDraft(item: Record<string, unknown>): CalendarDraft {
  return {
    draftId: item.draftId as string,
    workspaceId: item.workspaceId as string,
    userId: item.userId as string | undefined,
    title: item.title as string,
    notes: item.notes as string | undefined,
    sourceId: item.sourceId as string | undefined,
    sourceRef: item.sourceRef as string | undefined,
    calendarId: item.calendarId as string | undefined,
    status: item.status as CalendarDraftStatus,
    candidates: item.candidates as CalendarDraft["candidates"],
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
    approvedAt: item.approvedAt as string | undefined,
    rejectedAt: item.rejectedAt as string | undefined,
    lastAppliedAt: item.lastAppliedAt as string | undefined,
  };
}
