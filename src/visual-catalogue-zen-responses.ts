export * from "./visual-catalogue-zen-responses-base";

import { ConnectorError } from "./errors";
import {
  ZEN_RESPONSES_ENDPOINT,
  ZEN_RESPONSES_MODEL,
  buildZenResponsesRequest as buildZenResponsesRequestBase,
  ZenResponsesTransportError,
  isZenResponsesTransportError,
  requestZenResponses as requestZenResponsesBase,
  type ZenResponsesTransportReceipt as BaseZenResponsesTransportReceipt,
} from "./visual-catalogue-zen-responses-base";
import { sha256HexUtf8 } from "./paid-core";
import { syntheticVisionProbeJpegBytes } from "./visual-catalogue-probe-fixture";
import {
  assertZenVisionFixtureRecognition,
  classifyZenVisionProviderError,
  classifyZenVisionProviderText,
  inspectZenVisionProviderText,
  inspectZenVisionRequest,
  type ZenVisionProviderOutputClass,
  type ZenVisionRequestReceipt,
  type ZenVisionSemanticReceipt,
} from "./visual-zen-responses-vision";

// Compatibility-visible base invariants remain MAX_RESPONSE_BYTES = 64 * 1024
// and ZEN_RESPONSES_TIMEOUT_MS = 60_000 in visual-catalogue-zen-responses-base.ts.
const ZEN_RESPONSES_REDIRECT_MAX_HOPS = 1;
const ZEN_RESPONSES_PROVIDER_ERROR_INSPECTION_MAX_BYTES = 64 * 1024;
const ZEN_RESPONSES_ALLOWED_HOST = "opencode.ai";
const ZEN_RESPONSES_ALLOWED_PATHS = new Set([
  "/zen/v1/responses",
  "/zen/v1/responses/",
]);

type ZenResponsesRequestBuildInput = Parameters<typeof buildZenResponsesRequestBase>[0];

export function buildZenResponsesRequest(input: ZenResponsesRequestBuildInput): Record<string, unknown> {
  const request = buildZenResponsesRequestBase(input);
  if (!input.imageDataUrl) return request;
  const messages = Array.isArray(request.input) ? request.input as Record<string, unknown>[] : [];
  const content = messages.length === 1 && Array.isArray(messages[0].content)
    ? messages[0].content as Record<string, unknown>[]
    : [];
  const image = content.find((part) => part.type === "input_image");
  if (image) image.detail = "auto";
  return request;
}

export type ZenResponsesRedirectDisposition =
  | "direct_canonical"
  | "accepted_bounded_redirect"
  | "disallowed_redirect"
  | "redirect_loop"
  | "redirect_hop_ceiling_exceeded"
  | "missing_redirect_location"
  | "malformed_redirect_location"
  | "protocol_downgrade"
  | "url_userinfo_rejected"
  | "ip_literal_rejected"
  | "unexpected_port"
  | "untrusted_redirect_host"
  | "untrusted_redirect_path"
  | "sensitive_redirect_query_rejected"
  | "unsafe_redirect_status_method_rewrite";

export type ZenResponsesRedirectReceipt = {
  redirectMode: "manual";
  redirectDisposition: ZenResponsesRedirectDisposition;
  redirectStatus: number | null;
  redirectHopCount: number;
  redirectOriginClass: "none" | "same_origin" | "cross_origin";
  redirectAllowlistDecision: "not_applicable" | "allowed" | "rejected";
  redirectSchemeClass: "https" | "http" | "other" | "unknown";
  redirectHostFingerprint: string | null;
  redirectPathFingerprint: string | null;
  finalEndpointClass: "documented_canonical" | "documented_slash_variant" | "not_reached";
};

export type ZenResponsesIncompleteReasonClass =
  | "max_output_tokens"
  | "content_filter"
  | "tool_failure"
  | "other"
  | null;

export type ZenResponsesCompletionEvidence = {
  requestedMaxOutputTokens: number | null;
  completionStatus: string | null;
  incompleteReason: string | null;
  incompleteReasonClass: ZenResponsesIncompleteReasonClass;
  reportedOutputTokens: number | null;
  outputTokensReachedRequestedCeiling: boolean | null;
  partialOutputTextPresent: boolean | null;
};

function sanitizedInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

function sanitizedProviderEnum(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase("en").replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 120);
  return normalized || null;
}

export function classifyZenResponsesIncompleteReason(reason: unknown): ZenResponsesIncompleteReasonClass {
  const normalized = sanitizedProviderEnum(reason);
  if (normalized === null) return null;
  if (normalized === "max_output_tokens" || normalized === "max_tokens" || normalized === "length") return "max_output_tokens";
  if (normalized === "content_filter" || normalized.includes("content_filter")) return "content_filter";
  if (normalized === "tool_failure" || normalized === "tool_error" || normalized.includes("tool_failure")) return "tool_failure";
  return "other";
}

export function inspectZenResponsesCompletionEnvelope(
  body: Record<string, unknown>,
  requestedMaxOutputTokens: unknown,
): ZenResponsesCompletionEvidence {
  const requested = sanitizedInteger(requestedMaxOutputTokens);
  const completionStatus = sanitizedProviderEnum(body.status);
  const incompleteDetails = body.incomplete_details && typeof body.incomplete_details === "object" && !Array.isArray(body.incomplete_details)
    ? body.incomplete_details as Record<string, unknown>
    : null;
  const incompleteReason = sanitizedProviderEnum(incompleteDetails?.reason);
  const usage = body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
    ? body.usage as Record<string, unknown>
    : null;
  const reportedOutputTokens = sanitizedInteger(usage?.output_tokens ?? usage?.completion_tokens);
  const completionKnown = completionStatus !== null;
  let outputTextPresent = false;
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  for (const item of output) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content as Record<string, unknown>[] : [];
    if (content.some((part) => part.type === "output_text" && typeof part.text === "string" && part.text.trim().length > 0)) {
      outputTextPresent = true;
      break;
    }
  }
  return {
    requestedMaxOutputTokens: requested,
    completionStatus,
    incompleteReason,
    incompleteReasonClass: classifyZenResponsesIncompleteReason(incompleteReason),
    reportedOutputTokens,
    outputTokensReachedRequestedCeiling: requested !== null && reportedOutputTokens !== null
      ? reportedOutputTokens >= requested
      : null,
    partialOutputTextPresent: completionKnown ? outputTextPresent : null,
  };
}

export type ZenResponsesTransportReceipt = Omit<BaseZenResponsesTransportReceipt, "redirectMode"> & {
  redirectMode: "error" | "manual";
  redirectDisposition?: ZenResponsesRedirectDisposition;
  redirectStatus?: number | null;
  redirectHopCount?: number;
  redirectOriginClass?: ZenResponsesRedirectReceipt["redirectOriginClass"];
  redirectAllowlistDecision?: ZenResponsesRedirectReceipt["redirectAllowlistDecision"];
  redirectSchemeClass?: ZenResponsesRedirectReceipt["redirectSchemeClass"];
  redirectHostFingerprint?: string | null;
  redirectPathFingerprint?: string | null;
  finalEndpointClass?: ZenResponsesRedirectReceipt["finalEndpointClass"];
  visionRequestReceipt?: ZenVisionRequestReceipt | null;
  providerOutputClass?: ZenVisionProviderOutputClass | null;
  fixtureRecognitionBoolean?: boolean | null;
  requestedMaxOutputTokens?: number | null;
  completionStatus?: string | null;
  incompleteReason?: string | null;
  incompleteReasonClass?: ZenResponsesIncompleteReasonClass;
  reportedOutputTokens?: number | null;
  outputTokensReachedRequestedCeiling?: boolean | null;
  partialOutputTextPresent?: boolean | null;
};

type RequestInput = Parameters<typeof requestZenResponsesBase>[0];
type RedirectedTransportReceipt = Omit<BaseZenResponsesTransportReceipt, "redirectMode"> & ZenResponsesRedirectReceipt & ZenResponsesCompletionEvidence & {
  visionRequestReceipt?: ZenVisionRequestReceipt | null;
  providerOutputClass?: ZenVisionProviderOutputClass | null;
  fixtureRecognitionBoolean?: boolean | null;
};
type RequestResult = Omit<Awaited<ReturnType<typeof requestZenResponsesBase>>, "transportReceipt"> & {
  transportReceipt: ZenResponsesTransportReceipt;
  visionSemanticReceipt?: ZenVisionSemanticReceipt | null;
};
type FetchFunction = typeof fetch;

type RedirectFailure = {
  code: string;
  message: string;
  localErrorClass: string;
  disposition: ZenResponsesRedirectDisposition;
  status: number | null;
  originClass: ZenResponsesRedirectReceipt["redirectOriginClass"];
  allowlistDecision: ZenResponsesRedirectReceipt["redirectAllowlistDecision"];
  schemeClass: ZenResponsesRedirectReceipt["redirectSchemeClass"];
  host: string | null;
  path: string | null;
};

type RedirectTrace = {
  disposition: ZenResponsesRedirectDisposition;
  status: number | null;
  hopCount: number;
  originClass: ZenResponsesRedirectReceipt["redirectOriginClass"];
  allowlistDecision: ZenResponsesRedirectReceipt["redirectAllowlistDecision"];
  schemeClass: ZenResponsesRedirectReceipt["redirectSchemeClass"];
  host: string | null;
  path: string | null;
  finalEndpointClass: ZenResponsesRedirectReceipt["finalEndpointClass"];
  failure: RedirectFailure | null;
  providerErrorClass: "invalid_image_payload" | "explicit_multimodal_unsupported" | null;
  completionEvidence: ZenResponsesCompletionEvidence;
};

function initialTrace(requestedMaxOutputTokens: unknown = null): RedirectTrace {
  return {
    disposition: "direct_canonical",
    status: null,
    hopCount: 0,
    originClass: "none",
    allowlistDecision: "not_applicable",
    schemeClass: "https",
    host: ZEN_RESPONSES_ALLOWED_HOST,
    path: "/zen/v1/responses",
    finalEndpointClass: "documented_canonical",
    failure: null,
    providerErrorClass: null,
    completionEvidence: inspectZenResponsesCompletionEnvelope({}, requestedMaxOutputTokens),
  };
}

function isIpLiteral(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized);
}

function schemeClass(url: URL): ZenResponsesRedirectReceipt["redirectSchemeClass"] {
  if (url.protocol === "https:") return "https";
  if (url.protocol === "http:") return "http";
  return "other";
}

function originClass(from: URL, to: URL): ZenResponsesRedirectReceipt["redirectOriginClass"] {
  return from.origin === to.origin ? "same_origin" : "cross_origin";
}

function endpointClass(pathname: string): ZenResponsesRedirectReceipt["finalEndpointClass"] {
  return pathname === "/zen/v1/responses/"
    ? "documented_slash_variant"
    : pathname === "/zen/v1/responses"
      ? "documented_canonical"
      : "not_reached";
}

function redirectFailure(
  trace: RedirectTrace,
  failure: RedirectFailure,
): never {
  trace.disposition = failure.disposition;
  trace.status = failure.status;
  trace.originClass = failure.originClass;
  trace.allowlistDecision = failure.allowlistDecision;
  trace.schemeClass = failure.schemeClass;
  trace.host = failure.host;
  trace.path = failure.path;
  trace.finalEndpointClass = "not_reached";
  trace.failure = failure;
  const error = new Error(failure.code);
  error.name = "ZenResponsesRedirectPolicyError";
  throw error;
}

function validateRedirectTarget(
  current: URL,
  status: number,
  location: string | null,
  trace: RedirectTrace,
): URL {
  if (![307, 308].includes(status)) {
    redirectFailure(trace, {
      code: "zen_responses_redirect_unsafe_method_rewrite",
      message: "The Zen Responses redirect status would not safely preserve POST semantics.",
      localErrorClass: "unsafe_redirect_status",
      disposition: "unsafe_redirect_status_method_rewrite",
      status,
      originClass: "none",
      allowlistDecision: "rejected",
      schemeClass: "unknown",
      host: null,
      path: null,
    });
  }
  if (location === null || location.trim() === "") {
    redirectFailure(trace, {
      code: "zen_responses_redirect_location_missing",
      message: "The Zen Responses redirect did not provide a Location value.",
      localErrorClass: "missing_redirect_location",
      disposition: "missing_redirect_location",
      status,
      originClass: "none",
      allowlistDecision: "rejected",
      schemeClass: "unknown",
      host: null,
      path: null,
    });
  }

  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    redirectFailure(trace, {
      code: "zen_responses_redirect_location_malformed",
      message: "The Zen Responses redirect Location value was malformed.",
      localErrorClass: "malformed_redirect_location",
      disposition: "malformed_redirect_location",
      status,
      originClass: "none",
      allowlistDecision: "rejected",
      schemeClass: "unknown",
      host: null,
      path: null,
    });
  }

  const targetScheme = schemeClass(target);
  const targetOrigin = originClass(current, target);
  const structural = {
    status,
    originClass: targetOrigin,
    schemeClass: targetScheme,
    host: target.hostname || null,
    path: target.pathname || null,
  };

  if (target.protocol !== "https:") {
    redirectFailure(trace, {
      code: "zen_responses_redirect_protocol_downgrade",
      message: "The Zen Responses redirect target was not HTTPS.",
      localErrorClass: "protocol_downgrade",
      disposition: "protocol_downgrade",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (target.username !== "" || target.password !== "") {
    redirectFailure(trace, {
      code: "zen_responses_redirect_userinfo_rejected",
      message: "The Zen Responses redirect target contained URL userinfo.",
      localErrorClass: "url_userinfo",
      disposition: "url_userinfo_rejected",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (isIpLiteral(target.hostname)) {
    redirectFailure(trace, {
      code: "zen_responses_redirect_ip_literal_rejected",
      message: "The Zen Responses redirect target used an IP literal.",
      localErrorClass: "ip_literal",
      disposition: "ip_literal_rejected",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (target.port !== "" && target.port !== "443") {
    redirectFailure(trace, {
      code: "zen_responses_redirect_unexpected_port",
      message: "The Zen Responses redirect target used an unexpected port.",
      localErrorClass: "unexpected_port",
      disposition: "unexpected_port",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (target.hostname.toLowerCase() !== ZEN_RESPONSES_ALLOWED_HOST) {
    redirectFailure(trace, {
      code: "zen_responses_redirect_untrusted_host",
      message: "The Zen Responses redirect target host was not allowlisted.",
      localErrorClass: "untrusted_redirect_host",
      disposition: "untrusted_redirect_host",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (!ZEN_RESPONSES_ALLOWED_PATHS.has(target.pathname)) {
    redirectFailure(trace, {
      code: "zen_responses_redirect_untrusted_path",
      message: "The Zen Responses redirect target path was not allowlisted.",
      localErrorClass: "untrusted_redirect_path",
      disposition: "untrusted_redirect_path",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (target.search !== "" || target.hash !== "") {
    redirectFailure(trace, {
      code: "zen_responses_redirect_sensitive_query_rejected",
      message: "The Zen Responses redirect target contained a query or fragment.",
      localErrorClass: "sensitive_redirect_query",
      disposition: "sensitive_redirect_query_rejected",
      allowlistDecision: "rejected",
      ...structural,
    });
  }
  if (targetOrigin !== "same_origin") {
    redirectFailure(trace, {
      code: "zen_responses_redirect_cross_origin_rejected",
      message: "The Zen Responses redirect target was cross-origin.",
      localErrorClass: "cross_origin_redirect",
      disposition: "disallowed_redirect",
      allowlistDecision: "rejected",
      ...structural,
    });
  }

  trace.status = status;
  trace.originClass = targetOrigin;
  trace.allowlistDecision = "allowed";
  trace.schemeClass = targetScheme;
  trace.host = target.hostname;
  trace.path = target.pathname;
  return target;
}

function freshPostInit(source: RequestInit): RequestInit {
  const sourceHeaders = new Headers(source.headers);
  const authorization = sourceHeaders.get("authorization");
  const contentType = sourceHeaders.get("content-type");
  if (!authorization || !contentType || typeof source.body !== "string" || !source.signal) {
    const error = new Error("zen_responses_redirect_request_init_invalid");
    error.name = "ZenResponsesRedirectPolicyError";
    throw error;
  }
  const headers: Record<string, string> = {
    authorization,
    "content-type": contentType,
  };
  return {
    method: "POST",
    headers,
    body: source.body,
    redirect: "manual",
    signal: source.signal,
  };
}

function createBoundedZenResponsesRedirectFetchInternal(
  underlyingFetch: FetchFunction,
  trace: RedirectTrace,
): FetchFunction {
  return (async (input: RequestInfo | URL, sourceInit?: RequestInit): Promise<Response> => {
    if (typeof underlyingFetch !== "function") {
      throw new TypeError("Zen Responses fetch implementation is not callable.");
    }
    const initialUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (initialUrl.href !== ZEN_RESPONSES_ENDPOINT) {
      redirectFailure(trace, {
        code: "zen_responses_redirect_initial_endpoint_mismatch",
        message: "The Zen Responses transport attempted an unexpected initial endpoint.",
        localErrorClass: "endpoint_mismatch",
        disposition: "disallowed_redirect",
        status: null,
        originClass: "none",
        allowlistDecision: "rejected",
        schemeClass: schemeClass(initialUrl),
        host: initialUrl.hostname || null,
        path: initialUrl.pathname || null,
      });
    }
    const init = sourceInit ?? {};
    const visited = new Set<string>([initialUrl.href]);
    let current = initialUrl;

    for (let hop = 0; ; hop += 1) {
      const response = await underlyingFetch(current.href, freshPostInit(init));
      if (response.status < 300 || response.status > 399) {
        trace.hopCount = hop;
        trace.finalEndpointClass = endpointClass(current.pathname);
        if (hop > 0) trace.disposition = "accepted_bounded_redirect";
        if (/application\/json/i.test(response.headers.get("content-type") ?? "")) {
          const declared = Number(response.headers.get("content-length"));
          if (!Number.isFinite(declared) || declared <= ZEN_RESPONSES_PROVIDER_ERROR_INSPECTION_MAX_BYTES) {
            try {
              const bytes = new Uint8Array(await response.clone().arrayBuffer());
              if (bytes.byteLength <= ZEN_RESPONSES_PROVIDER_ERROR_INSPECTION_MAX_BYTES) {
                const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  const record = parsed as Record<string, unknown>;
                  trace.completionEvidence = inspectZenResponsesCompletionEnvelope(
                    record,
                    trace.completionEvidence.requestedMaxOutputTokens,
                  );
                  if (!response.ok) trace.providerErrorClass = classifyZenVisionProviderError(record);
                }
              }
            } catch {
              trace.providerErrorClass = null;
            }
          }
        }
        return response;
      }

      if (hop >= ZEN_RESPONSES_REDIRECT_MAX_HOPS) {
        redirectFailure(trace, {
          code: "zen_responses_redirect_hop_ceiling_exceeded",
          message: "The Zen Responses redirect hop ceiling was exceeded.",
          localErrorClass: "redirect_hop_ceiling",
          disposition: "redirect_hop_ceiling_exceeded",
          status: response.status,
          originClass: "none",
          allowlistDecision: "rejected",
          schemeClass: "unknown",
          host: null,
          path: null,
        });
      }

      const target = validateRedirectTarget(current, response.status, response.headers.get("location"), trace);
      if (visited.has(target.href)) {
        redirectFailure(trace, {
          code: "zen_responses_redirect_loop",
          message: "The Zen Responses redirect sequence formed a loop.",
          localErrorClass: "redirect_loop",
          disposition: "redirect_loop",
          status: response.status,
          originClass: originClass(current, target),
          allowlistDecision: "rejected",
          schemeClass: schemeClass(target),
          host: target.hostname || null,
          path: target.pathname || null,
        });
      }
      visited.add(target.href);
      trace.hopCount = hop + 1;
      current = target;
    }
  }) as FetchFunction;
}

export function createBoundedZenResponsesRedirectFetch(underlyingFetch: FetchFunction): FetchFunction {
  return createBoundedZenResponsesRedirectFetchInternal(underlyingFetch, initialTrace());
}

async function redirectReceipt(
  base: BaseZenResponsesTransportReceipt,
  trace: RedirectTrace,
): Promise<RedirectedTransportReceipt> {
  return {
    ...base,
    redirectMode: "manual",
    redirectDisposition: trace.disposition,
    redirectStatus: trace.status,
    redirectHopCount: trace.hopCount,
    redirectOriginClass: trace.originClass,
    redirectAllowlistDecision: trace.allowlistDecision,
    redirectSchemeClass: trace.schemeClass,
    redirectHostFingerprint: trace.host ? (await sha256HexUtf8(trace.host.toLowerCase())).slice(0, 24) : null,
    redirectPathFingerprint: trace.path ? (await sha256HexUtf8(trace.path)).slice(0, 24) : null,
    finalEndpointClass: trace.finalEndpointClass,
    ...trace.completionEvidence,
  } as RedirectedTransportReceipt;
}

async function transportReceiptKey(spendLedgerKey: string, correlationId: string): Promise<string> {
  const scopeFingerprint = (await sha256HexUtf8(spendLedgerKey)).slice(0, 32);
  return `visual-compiler/provider-transport/opencode-zen-responses/${ZEN_RESPONSES_MODEL}/${scopeFingerprint}/${correlationId}.json`;
}

async function persistRedirectReceipt(
  input: RequestInput,
  receipt: RedirectedTransportReceipt,
): Promise<void> {
  const key = await transportReceiptKey(input.spendLedgerKey, receipt.correlationId);
  await input.env.ARTIFACTS.put(key, JSON.stringify(receipt, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function persistRedirectReceiptBestEffort(
  input: RequestInput,
  receipt: RedirectedTransportReceipt,
): Promise<void> {
  try {
    await persistRedirectReceipt(input, receipt);
  } catch {
    // Preserve the already-classified transport or redirect failure.
  }
}

function selectUnderlyingFetch(input: RequestInput): FetchFunction | null {
  const hasExplicitFetch = Object.prototype.hasOwnProperty.call(input, "fetchImpl");
  if (hasExplicitFetch) return typeof input.fetchImpl === "function" ? input.fetchImpl : null;
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) as FetchFunction : null;
}

export async function requestZenResponses(input: RequestInput): Promise<RequestResult> {
  const stage = input.context.split(":").pop() ?? "";
  const visionRequestReceipt = stage.startsWith("vision_")
    ? await inspectZenVisionRequest(input.body, syntheticVisionProbeJpegBytes())
    : null;
  const underlyingFetch = selectUnderlyingFetch(input);
  if (!underlyingFetch) return requestZenResponsesBase(input);

  const trace = initialTrace(input.body.max_output_tokens);
  const boundedFetch = createBoundedZenResponsesRedirectFetchInternal(underlyingFetch, trace);

  try {
    const result = await requestZenResponsesBase({ ...input, fetchImpl: boundedFetch });
    const visionSemanticReceipt = visionRequestReceipt
      ? await inspectZenVisionProviderText(result.text, {
        completionStatus: trace.completionEvidence.completionStatus,
        requestedOutputCeiling: trace.completionEvidence.requestedMaxOutputTokens,
        reportedOutputTokens: trace.completionEvidence.reportedOutputTokens,
        outputTokensReachedRequestedCeiling: trace.completionEvidence.outputTokensReachedRequestedCeiling,
        partialOutputPresent: trace.completionEvidence.partialOutputTextPresent,
      })
      : null;
    const providerOutputClass = visionRequestReceipt ? classifyZenVisionProviderText(result.text) : null;
    const patched = {
      ...await redirectReceipt(result.transportReceipt, trace),
      visionRequestReceipt,
      providerOutputClass,
      fixtureRecognitionBoolean: providerOutputClass === null ? null : providerOutputClass === "fixture_recognized",
    } satisfies RedirectedTransportReceipt;
    await persistRedirectReceipt(input, patched);
    if (visionSemanticReceipt) {
      try {
        assertZenVisionFixtureRecognition(visionSemanticReceipt);
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        throw new ConnectorError(error.code, error.message, {
          retryable: error.retryable,
          status: result.status,
          correlationId: patched.correlationId,
          details: {
            transportReceipt: patched,
            visionSemanticReceipt,
            structuralReceipt: result.structuralReceipt,
            usage: result.usage,
            accounting: result.accounting,
            httpStatus: result.status,
          },
        });
      }
    }
    return { ...result, transportReceipt: patched, visionSemanticReceipt };
  } catch (error) {
    if (!isZenResponsesTransportError(error)) throw error;
    const patched = {
      ...await redirectReceipt(error.receipt, trace),
      visionRequestReceipt,
      providerOutputClass: null,
      fixtureRecognitionBoolean: null,
    } satisfies RedirectedTransportReceipt;

    if (trace.failure) {
      const failed = {
        ...patched,
        localErrorCode: trace.failure.code,
        localErrorClass: trace.failure.localErrorClass,
        errorName: "ZenResponsesRedirectPolicyError",
        errorMessage: trace.failure.message,
        codeLocation: "visual-catalogue-zen-responses.requestZenResponses.redirect_policy",
      } as RedirectedTransportReceipt;
      await persistRedirectReceiptBestEffort(input, failed);
      throw new ZenResponsesTransportError(
        trace.failure.code,
        trace.failure.message,
        failed as unknown as BaseZenResponsesTransportReceipt,
        { retryable: false },
      );
    }

    if (error.code === "zen_responses_http_error" && trace.providerErrorClass) {
      const code = trace.providerErrorClass === "invalid_image_payload"
        ? "provider_invalid_image_payload"
        : "provider_multimodal_unsupported";
      const message = trace.providerErrorClass === "invalid_image_payload"
        ? "The provider rejected the image payload as invalid."
        : "The provider explicitly rejected multimodal image input as unsupported.";
      const remapped = { ...patched, localErrorCode: code, localErrorClass: code } satisfies RedirectedTransportReceipt;
      await persistRedirectReceiptBestEffort(input, remapped);
      throw new ZenResponsesTransportError(code, message, remapped as unknown as BaseZenResponsesTransportReceipt, { retryable: false, status: error.status });
    }

    Object.assign(error.receipt as object, patched);
    const details = (error as unknown as { details?: { transportReceipt?: unknown } }).details;
    if (details) details.transportReceipt = error.receipt;
    await persistRedirectReceiptBestEffort(input, patched);
    throw error;
  }
}
