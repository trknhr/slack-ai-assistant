export type CalendarDraftStatus = "pending" | "approved" | "applied" | "rejected";

export type CalendarDraftCandidateStatus = "pending" | "applied" | "rejected";

export interface CalendarDraftCandidate {
  candidateId: string;
  summary: string;
  description?: string;
  location?: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  sourceText?: string;
  confidence?: number;
  dedupeKey?: string;
  status: CalendarDraftCandidateStatus;
  calendarEventId?: string;
  calendarEventHtmlLink?: string;
  appliedAt?: string;
  rejectedAt?: string;
}

export interface CalendarDraft {
  draftId: string;
  workspaceId: string;
  userId?: string;
  title: string;
  notes?: string;
  sourceId?: string;
  sourceRef?: string;
  calendarId?: string;
  status: CalendarDraftStatus;
  candidates: CalendarDraftCandidate[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  lastAppliedAt?: string;
}
