import { ConnectorError } from "./errors";
import { base64ToBytes, bytesToBase64, sha256Bytes } from "./integrated-core";
import { canonicalJson, sha256HexUtf8 } from "./paid-core";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const MAX_CAPABILITY_JPEG_BYTES = 64 * 1024;

export type ZenVisionProviderOutputClass =
  | "fixture_recognized"
  | "fixture_recognition_failed"
  | "image_ignored_or_stripped"
  | "explicit_multimodal_unsupported";

export type ZenVisionRequestReceipt = {
  version: 1;
  inputItemCount: number;
  contentItemCount: number;
  contentItemTypes: string[];
  mimeType: "image/jpeg";
  decodedImageByteCount: number;
  imageSha256: string;
  dataUrlPrefixClass: "data_image_jpeg_base64";
  detail: "auto";
  imageRoundTripMatched: true;
  requestShapeFingerprint: string;
};

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertBoundedJpeg(bytes: Uint8Array): void {
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_CAPABILITY_JPEG_BYTES) {
    throw new ConnectorError("vision_fixture_jpeg_size_invalid", "The bounded vision fixture JPEG size was invalid.");
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9) {
    throw new ConnectorError("vision_fixture_jpeg_signature_invalid", "The bounded vision fixture did not have a valid JPEG signature.");
  }
}

export function buildBoundedZenVisionDataUrl(bytes: Uint8Array): string {
  assertBoundedJpeg(bytes);
  const encoded = bytesToBase64(bytes);
  const decoded = base64ToBytes(encoded);
  if (!equalBytes(decoded, bytes)) {
    throw new ConnectorError("vision_fixture_base64_round_trip_failed", "The bounded vision fixture did not survive base64 round-trip validation.");
  }
  return `${JPEG_DATA_URL_PREFIX}${encoded}`;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError(code, "The Zen Responses vision request shape was invalid.");
  }
  return value as Record<string, unknown>;
}

export async function inspectZenVisionRequest(
  request: Record<string, unknown>,
  expectedJpegBytes: Uint8Array,
): Promise<ZenVisionRequestReceipt> {
  assertBoundedJpeg(expectedJpegBytes);
  const input = Array.isArray(request.input) ? request.input : [];
  if (input.length !== 1) {
    throw new ConnectorError("vision_request_user_message_invalid", "The Zen Responses vision request must contain exactly one user message.");
  }
  const message = requireRecord(input[0], "vision_request_user_message_invalid");
  if (message.role !== "user") {
    throw new ConnectorError("vision_request_user_message_invalid", "The Zen Responses vision request must contain exactly one user message.");
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (content.length !== 2) {
    throw new ConnectorError("vision_request_content_items_invalid", "The Zen Responses vision request must contain exactly one input_text and one input_image item.");
  }
  const text = requireRecord(content[0], "vision_request_text_missing");
  const image = requireRecord(content[1], "vision_request_image_missing");
  if (text.type !== "input_text" || typeof text.text !== "string" || text.text.trim() === "") {
    throw new ConnectorError("vision_request_text_missing", "The Zen Responses vision request input_text item was missing or malformed.");
  }
  if (image.type !== "input_image") {
    throw new ConnectorError("vision_request_image_missing", "The Zen Responses vision request input_image item was missing.");
  }
  if (image.detail !== "auto") {
    throw new ConnectorError("vision_request_image_detail_invalid", "The Zen Responses vision request image detail must be auto.");
  }
  if (typeof image.image_url !== "string" || !image.image_url.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new ConnectorError("vision_request_image_data_url_invalid", "The Zen Responses vision request image URL was not a JPEG data URL.");
  }
  const encoded = image.image_url.slice(JPEG_DATA_URL_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ConnectorError("vision_request_image_base64_invalid", "The Zen Responses vision request image base64 payload was malformed.");
  }
  let decoded: Uint8Array;
  try {
    decoded = base64ToBytes(encoded);
  } catch {
    throw new ConnectorError("vision_request_image_base64_invalid", "The Zen Responses vision request image base64 payload was malformed.");
  }
  assertBoundedJpeg(decoded);
  if (!equalBytes(decoded, expectedJpegBytes)) {
    throw new ConnectorError("vision_request_image_bytes_changed", "The Zen Responses vision request image bytes changed before dispatch.");
  }
  const imageSha256 = await sha256Bytes(decoded);
  const shape = {
    topLevelKeys: Object.keys(request).sort(),
    inputItemCount: input.length,
    contentItemCount: content.length,
    contentItemTypes: content.map((item) => String(requireRecord(item, "vision_request_content_items_invalid").type ?? "unknown")),
    imageMimeType: "image/jpeg",
    imageDetail: "auto",
    decodedImageByteCount: decoded.byteLength,
    imageSha256,
    structuredSchemaPresent: Boolean(request.text && typeof request.text === "object"),
  };
  return {
    version: 1,
    inputItemCount: input.length,
    contentItemCount: content.length,
    contentItemTypes: shape.contentItemTypes,
    mimeType: "image/jpeg",
    decodedImageByteCount: decoded.byteLength,
    imageSha256,
    dataUrlPrefixClass: "data_image_jpeg_base64",
    detail: "auto",
    imageRoundTripMatched: true,
    requestShapeFingerprint: await sha256HexUtf8(canonicalJson(shape)),
  };
}

function fixtureMatched(text: string): boolean {
  const lower = text.toLocaleLowerCase("en");
  return text.includes("UCA VISION PROBE 2047")
    && lower.includes("blue")
    && lower.includes("square")
    && lower.includes("red")
    && lower.includes("circle");
}

export function classifyZenVisionProviderText(text: string): ZenVisionProviderOutputClass {
  if (fixtureMatched(text)) return "fixture_recognized";
  const normalized = text.replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  if (/(?:image|vision|multimodal).{0,40}(?:not supported|unsupported)|(?:text[- ]only model)|(?:do not|don't|cannot|can't|unable to).{0,30}(?:support|process).{0,30}(?:image|vision|multimodal)/i.test(normalized)) {
    return "explicit_multimodal_unsupported";
  }
  if (/(?:no|without).{0,20}(?:image|attachment)|(?:image|attachment).{0,30}(?:not provided|not attached|missing|unavailable|not accessible)|(?:cannot|can't|unable to).{0,20}(?:see|view|access).{0,20}(?:image|attachment)/i.test(normalized)) {
    return "image_ignored_or_stripped";
  }
  return "fixture_recognition_failed";
}

export function assertZenVisionFixtureRecognition(text: string): ZenVisionProviderOutputClass {
  const outputClass = classifyZenVisionProviderText(text);
  if (outputClass === "fixture_recognized") return outputClass;
  if (outputClass === "explicit_multimodal_unsupported") {
    throw new ConnectorError("provider_multimodal_unsupported", "The provider explicitly reported that multimodal image input is unsupported.");
  }
  if (outputClass === "image_ignored_or_stripped") {
    throw new ConnectorError("provider_image_input_ignored", "The completed provider output indicated that the image input was absent, stripped, or inaccessible.");
  }
  throw new ConnectorError("provider_visual_fixture_mismatch", "The completed provider output did not recognize the deterministic vision fixture.");
}

export function classifyZenVisionProviderError(body: Record<string, unknown>): "invalid_image_payload" | "explicit_multimodal_unsupported" | null {
  const error = body.error && typeof body.error === "object" && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : body;
  const material = [error.code, error.type, error.message, error.param].filter((value) => typeof value === "string").join(" ").toLocaleLowerCase("en");
  if (!material) return null;
  if (/(invalid|malformed|corrupt|decode|base64|mime|format).{0,40}(image|jpeg)|(image|jpeg).{0,40}(invalid|malformed|corrupt|decode|base64|mime|format)/i.test(material)) {
    return "invalid_image_payload";
  }
  if (/(image|vision|multimodal).{0,40}(not supported|unsupported)|text[- ]only/i.test(material)) {
    return "explicit_multimodal_unsupported";
  }
  return null;
}
