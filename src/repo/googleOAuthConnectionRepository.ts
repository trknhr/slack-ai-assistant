import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";

export interface GoogleOAuthConnection {
  workspaceId: string;
  userId: string;
  googleSubject?: string;
  googleEmail?: string;
  refreshToken: string;
  calendarId?: string;
  timeZone?: string;
  scopes?: string[];
  connectedAt: string;
  updatedAt: string;
}

function buildPk(workspaceId: string, userId: string): string {
  return `WORKSPACE#${workspaceId}#USER#${userId}`;
}

export class GoogleOAuthConnectionRepository {
  constructor(private readonly tableName: string) {}

  async get(workspaceId: string, userId: string): Promise<GoogleOAuthConnection | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildPk(workspaceId, userId),
          sk: "GOOGLE_CALENDAR",
        },
      }),
    );

    return response.Item ? mapConnection(response.Item) : null;
  }

  async save(
    connection: Omit<GoogleOAuthConnection, "connectedAt" | "updatedAt"> &
      Partial<Pick<GoogleOAuthConnection, "connectedAt" | "updatedAt">>,
  ): Promise<GoogleOAuthConnection> {
    const now = new Date().toISOString();
    const existing = await this.get(connection.workspaceId, connection.userId);
    const record: GoogleOAuthConnection = {
      ...connection,
      connectedAt: existing?.connectedAt ?? connection.connectedAt ?? now,
      updatedAt: connection.updatedAt ?? now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.workspaceId, record.userId),
          sk: "GOOGLE_CALENDAR",
          workspaceId: record.workspaceId,
          userId: record.userId,
          googleSubject: record.googleSubject,
          googleEmail: record.googleEmail,
          refreshToken: record.refreshToken,
          calendarId: record.calendarId,
          timeZone: record.timeZone,
          scopes: record.scopes,
          connectedAt: record.connectedAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }
}

function mapConnection(item: Record<string, unknown>): GoogleOAuthConnection {
  return {
    workspaceId: item.workspaceId as string,
    userId: item.userId as string,
    googleSubject: item.googleSubject as string | undefined,
    googleEmail: item.googleEmail as string | undefined,
    refreshToken: item.refreshToken as string,
    calendarId: item.calendarId as string | undefined,
    timeZone: item.timeZone as string | undefined,
    scopes: item.scopes as string[] | undefined,
    connectedAt: item.connectedAt as string,
    updatedAt: item.updatedAt as string,
  };
}
