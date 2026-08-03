export type CapabilityStage =
  | "model_discovery"
  | "text_structured_output"
  | "vision_unstructured"
  | "vision_structured_output";

export type NormalizedResponseClass =
  | "success"
  | "authentication_failed"
  | "authorization_failed"
  | "model_missing"
  | "unsupported_media"
  | "invalid_request"
  | "rate_limited"
  | "provider_server_error"
  | "network_failure"
  | "timeout"
  | "malformed_success_response"
  | "structured_output_failure"
  | "unknown_provider_failure";

export function parseRetryAfterSeconds(raw: string | null, nowMilliseconds = Date.now(), maximumSeconds = 7200): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(maximumSeconds, Math.ceil(seconds)) : null;
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(maximumSeconds, Math.max(0, Math.ceil((date - nowMilliseconds) / 1000)));
}

export function normalizedResponseClass(status: number | null, options: {
  networkFailure?: boolean;
  timeout?: boolean;
  modelMissing?: boolean;
  unsupportedMedia?: boolean;
  malformedSuccess?: boolean;
  structuredFailure?: boolean;
} = {}): NormalizedResponseClass {
  if (options.timeout) return "timeout";
  if (options.networkFailure) return "network_failure";
  if (options.modelMissing) return "model_missing";
  if (options.unsupportedMedia) return "unsupported_media";
  if (options.malformedSuccess) return "malformed_success_response";
  if (options.structuredFailure) return "structured_output_failure";
  if (status !== null && status >= 200 && status < 300) return "success";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "authorization_failed";
  if (status === 415 || status === 422) return "unsupported_media";
  if (status === 400) return "invalid_request";
  if (status === 404) return "model_missing";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500 && status <= 599) return "provider_server_error";
  return "unknown_provider_failure";
}

export function responseClassRetryable(value: NormalizedResponseClass): boolean {
  return value === "rate_limited" || value === "provider_server_error" || value === "network_failure" || value === "timeout";
}

export function sanitizeProviderError(value: unknown): { code: string | null; message: string | null } {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = object.error && typeof object.error === "object" ? object.error as Record<string, unknown> : object;
  const clean = (raw: unknown, maximum: number): string | null => {
    if (raw === null || raw === undefined) return null;
    let text = String(raw);
    text = text
      .replace(/(?:bearer|authorization|api[-_ ]?key|token|secret)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]")
      .replace(/\bsk-[A-Za-z0-9._-]+\b/gi, "[redacted]")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
      .replace(/<[^>]+>/g, " ")
      .replace(/(?:cookie|set-cookie|x-api-key|authorization)\s*:[^\r\n]+/gi, "[redacted-header]")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return text ? text.slice(0, maximum) : null;
  };
  return { code: clean(nested.code ?? nested.type ?? object.code, 120), message: clean(nested.message ?? object.message, 500) };
}
