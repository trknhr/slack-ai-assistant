import { z } from "zod";

export interface GoogleCalendarEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleCalendarEventRecord {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  updated?: string;
  start?: GoogleCalendarEventTime;
  end?: GoogleCalendarEventTime;
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

interface GoogleOAuthToken {
  access_token: string;
  expires_in?: number;
}

export interface GoogleCalendarCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  timeZone: string;
}

interface GoogleCalendarApiError {
  error?: {
    message?: string;
  };
}

const googleCalendarSecretSchema = z
  .object({
    client_id: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    calendar_id: z.string().min(1).optional(),
    calendarId: z.string().min(1).optional(),
    time_zone: z.string().min(1).optional(),
    timeZone: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!(value.client_id ?? value.clientId)) {
      ctx.addIssue({
        code: "custom",
        message: "Google Calendar secret is missing client_id",
        path: ["client_id"],
      });
    }
    if (!(value.client_secret ?? value.clientSecret)) {
      ctx.addIssue({
        code: "custom",
        message: "Google Calendar secret is missing client_secret",
        path: ["client_secret"],
      });
    }
  });

export class GoogleCalendarClient {
  private credentialsPromise?: Promise<GoogleCalendarCredentials>;
  private accessTokenPromise?: Promise<{ accessToken: string; expiresAt: number }>;
  private cachedAccessToken?: { accessToken: string; expiresAt: number };

  constructor(
    private readonly options: {
      secretProvider?: () => Promise<string>;
      credentialsProvider?: () => Promise<GoogleCalendarCredentials>;
      defaultTimeZone: string;
    },
  ) {}

  async listEvents(input: {
    calendarId?: string;
    timeMin?: string;
    timeMax?: string;
    query?: string;
    maxResults?: number;
    timeZone?: string;
    privateProperties?: Record<string, string>;
  }): Promise<{
    calendarId: string;
    timeZone: string;
    events: GoogleCalendarEventRecord[];
  }> {
    const credentials = await this.getCredentials();
    const calendarId = input.calendarId ?? credentials.calendarId;
    const query = new URLSearchParams();
    query.set("singleEvents", "true");
    query.set("showDeleted", "false");
    query.set("orderBy", "startTime");
    query.set("maxResults", `${Math.min(Math.max(input.maxResults ?? 10, 1), 50)}`);
    query.set("timeZone", input.timeZone ?? credentials.timeZone);
    if (input.timeMin) {
      query.set("timeMin", input.timeMin);
    }
    if (input.timeMax) {
      query.set("timeMax", input.timeMax);
    }
    if (input.query) {
      query.set("q", input.query);
    }
    for (const [key, value] of Object.entries(input.privateProperties ?? {})) {
      query.append("privateExtendedProperty", `${key}=${value}`);
    }

    const response = await this.requestJson<{ items?: GoogleCalendarEventRecord[] }>(
      "GET",
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`,
    );

    return {
      calendarId,
      timeZone: input.timeZone ?? credentials.timeZone,
      events: response.items ?? [],
    };
  }

  async findEventByPrivateProperties(input: {
    calendarId?: string;
    privateProperties: Record<string, string>;
  }): Promise<GoogleCalendarEventRecord | null> {
    const result = await this.listEvents({
      calendarId: input.calendarId,
      maxResults: 10,
      privateProperties: input.privateProperties,
    });

    return result.events.find((event) => event.status !== "cancelled") ?? null;
  }

  async createEvent(input: {
    calendarId?: string;
    body: Record<string, unknown>;
  }): Promise<GoogleCalendarEventRecord> {
    const credentials = await this.getCredentials();
    const calendarId = input.calendarId ?? credentials.calendarId;
    return this.requestJson<GoogleCalendarEventRecord>(
      "POST",
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      input.body,
    );
  }

  async patchEvent(input: {
    calendarId?: string;
    eventId: string;
    body: Record<string, unknown>;
  }): Promise<GoogleCalendarEventRecord> {
    const credentials = await this.getCredentials();
    const calendarId = input.calendarId ?? credentials.calendarId;
    return this.requestJson<GoogleCalendarEventRecord>(
      "PATCH",
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`,
      input.body,
    );
  }

  async deleteEvent(input: {
    calendarId?: string;
    eventId: string;
  }): Promise<void> {
    const credentials = await this.getCredentials();
    const calendarId = input.calendarId ?? credentials.calendarId;
    await this.requestJson(
      "DELETE",
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    );
  }

  async queryFreeBusy(input: {
    calendarIds?: string[];
    timeMin: string;
    timeMax: string;
    timeZone?: string;
  }): Promise<{
    timeMin: string;
    timeMax: string;
    timeZone: string;
    calendars: Record<
      string,
      {
        busy?: Array<{ start: string; end: string }>;
        errors?: Array<{ domain?: string; reason?: string }>;
      }
    >;
  }> {
    const credentials = await this.getCredentials();
    const calendarIds = input.calendarIds?.length ? input.calendarIds : [credentials.calendarId];
    const timeZone = input.timeZone ?? credentials.timeZone;
    const response = await this.requestJson<{
      timeMin: string;
      timeMax: string;
      calendars?: Record<
        string,
        {
          busy?: Array<{ start: string; end: string }>;
          errors?: Array<{ domain?: string; reason?: string }>;
        }
      >;
    }>("POST", "/calendar/v3/freeBusy", {
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      timeZone,
      items: calendarIds.map((id) => ({ id })),
    });

    return {
      timeMin: response.timeMin,
      timeMax: response.timeMax,
      timeZone,
      calendars: response.calendars ?? {},
    };
  }

  private async getCredentials(): Promise<GoogleCalendarCredentials> {
    if (!this.credentialsPromise) {
      this.credentialsPromise = this.loadCredentials();
    }
    return this.credentialsPromise;
  }

  private async loadCredentials(): Promise<GoogleCalendarCredentials> {
    if (this.options.credentialsProvider) {
      return this.options.credentialsProvider();
    }
    if (!this.options.secretProvider) {
      throw new Error("Google Calendar credentials are not configured");
    }

    const raw = await this.options.secretProvider();
    const parsed = googleCalendarSecretSchema.parse(JSON.parse(raw));
    const refreshToken = parsed.refresh_token ?? parsed.refreshToken;
    if (!refreshToken) {
      throw new Error("Google Calendar secret is missing refresh_token");
    }

    return {
      clientId: parsed.client_id ?? parsed.clientId!,
      clientSecret: parsed.client_secret ?? parsed.clientSecret!,
      refreshToken,
      calendarId: parsed.calendar_id ?? parsed.calendarId ?? "primary",
      timeZone: parsed.time_zone ?? parsed.timeZone ?? this.options.defaultTimeZone,
    };
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > now + 60_000) {
      return this.cachedAccessToken.accessToken;
    }

    if (!this.accessTokenPromise) {
      this.accessTokenPromise = this.fetchAccessToken().finally(() => {
        this.accessTokenPromise = undefined;
      });
    }

    const token = await this.accessTokenPromise;
    this.cachedAccessToken = token;
    return token.accessToken;
  }

  private async fetchAccessToken(): Promise<{ accessToken: string; expiresAt: number }> {
    const credentials = await this.getCredentials();
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error(await buildGoogleApiErrorMessage(response, "Failed to refresh Google OAuth token"));
    }

    const token = (await response.json()) as GoogleOAuthToken;
    return {
      accessToken: token.access_token,
      expiresAt: Date.now() + Math.max((token.expires_in ?? 3600) - 60, 60) * 1000,
    };
  }

  private async requestJson<T = void>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`https://www.googleapis.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body
          ? {
              "content-type": "application/json; charset=utf-8",
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(await buildGoogleApiErrorMessage(response, "Google Calendar API request failed"));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

async function buildGoogleApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `${fallback}: ${response.status} ${response.statusText}`;
  }

  try {
    const parsed = JSON.parse(text) as GoogleCalendarApiError;
    const message = parsed.error?.message;
    return message
      ? `${fallback}: ${message}`
      : `${fallback}: ${response.status} ${response.statusText}`;
  } catch {
    return `${fallback}: ${response.status} ${response.statusText}`;
  }
}
