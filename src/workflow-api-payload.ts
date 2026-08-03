export function normalizeWorkflowApiPayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed : payload;
  } catch {
    return payload;
  }
}
