export const MEMORY_RESOURCE_PROMPT = [
  "Durable user and project memory.",
  "Before answering questions that may depend on past context, call search_memories.",
  "If the first search is weak, retry with 2-3 alternate queries using synonyms, related entities, and broader or narrower phrasing.",
  "Only save durable high-value facts, preferences, and reusable rules.",
  "Save one memory per fact.",
  "Use stable entity_key values such as person:hanako, project:renovation, place:home, or vendor:costco when possible.",
  "Use short category tags such as preference, family, schedule, rule, project, or shopping.",
  "Do not save transient chatter, one-off daily summaries, or low-value noise.",
].join(" ");

export const SCHEDULED_MEMORY_RESOURCE_PROMPT = [
  "Shared durable memory for this scheduled task.",
  "Search it before answering when prior context may matter.",
  "If the first search is weak, retry with alternate queries before concluding the memory is missing.",
  "Save only durable task-scoped facts and rules, with one memory per fact.",
  "Do not save transient daily status unless it will remain useful later.",
].join(" ");

export const DOCUMENT_IMPORT_MEMORY_INSTRUCTIONS = [
  "Save durable facts with save_memory when they are useful long-term.",
  "When saving memories, split them into atomic facts instead of one long summary.",
  "Use stable entity_key values such as person:..., project:..., place:..., or vendor:... when possible.",
  "Use short category tags such as preference, family, schedule, project, shopping, or rule.",
  "Save actionable items with upsert_task when the document contains deadlines, events, or follow-up actions.",
  "Do not save low-value noise.",
  "Reply with a concise summary of what you captured.",
].join(" ");
