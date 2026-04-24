export interface UserPreferenceItem {
  workspaceId: string;
  userId: string;
  preferenceId: string;
  text: string;
  preferenceKey?: string;
  entityKey?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
  importance?: number;
  origin: "explicit" | "inferred";
  sourceType?: string;
  sourceRef?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}
