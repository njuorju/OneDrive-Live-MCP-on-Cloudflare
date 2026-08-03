export function normalizeWorkflowApiPayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed : payload;
  } catch {
    return payload;
  }
}

export function extractWorkflowEventPayload(event: unknown): unknown {
  if (event !== null && typeof event === "object" && !Array.isArray(event) && "payload" in event) {
    return normalizeWorkflowApiPayload((event as { payload?: unknown }).payload);
  }
  return normalizeWorkflowApiPayload(event);
}
