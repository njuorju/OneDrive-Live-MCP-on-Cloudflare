import { ConnectorError } from "./errors";
import { base64ToBytes, bytesToBase64, sha256Bytes } from "./integrated-core";
import { canonicalJson, sha256HexUtf8 } from "./paid-core";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const MAX_CAPABILITY_JPEG_BYTES = 64 * 1024;

export type ZenVisionProviderOutputClass =
  | "fixture_recognized"
  | "fixture_partly_recognized"
  | "wrong_visual_facts"
  | "generic_visual_prose"
  | "image_ignored_or_stripped"
  | "refusal"
  | "explicit_multimodal_unsupported"
  | "completed_unclassifiable";

export type ZenVisionFixtureRecognitionStatus = "recognized" | "partly_recognized" | "not_recognized";

export const ZEN_VISION_MANDATORY_FEATURE_ORDER = [
  "blue_square",
  "red_circle",
  "visible_label",
] as const;

export const ZEN_VISION_CONTRADICTORY_FEATURE_ORDER = [
  "blue_wrong_shape",
  "red_wrong_shape",
  "square_wrong_color",
  "circle_wrong_color",
  "wrong_position",
  "wrong_count_or_label",
] as const;

export type ZenVisionSemanticReceipt = {
  version: 1;
  completionStatus: string | null;
  requestedOutputCeiling: number | null;
  reportedOutputTokens: number | null;
  outputTokensReachedRequestedCeiling: boolean | null;
  semanticClass: ZenVisionProviderOutputClass;
  fixtureRecognitionStatus: ZenVisionFixtureRecognitionStatus;
  mandatoryFeatureMatchBitmap: string;
  mandatoryFeatureMatchCount: number;
  contradictoryFeatureMatchBitmap: string;
  contradictoryFeatureMatchCount: number;
  refusalIndicator: boolean;
  genericIndicator: boolean;
  imageIgnoredIndicator: boolean;
  unsupportedIndicator: boolean;
  normalizedOutputSha256: string;
  partialOutputPresent: boolean;
};

export type ZenVisionCompletionEvidence = {
  completionStatus?: string | null;
  requestedOutputCeiling?: number | null;
  reportedOutputTokens?: number | null;
  outputTokensReachedRequestedCeiling?: boolean | null;
  partialOutputPresent?: boolean | null;
};

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

const BLUE_TERMS = new Set(["blue", "azure"]);
const RED_TERMS = new Set(["red", "crimson", "scarlet"]);
const SQUARE_TERMS = new Set(["square", "box"]);
const CIRCLE_TERMS = new Set(["circle", "disk", "disc"]);
const LEFT_TERMS = new Set(["left", "leftmost"]);
const RIGHT_TERMS = new Set(["right", "rightmost"]);
const WRONG_SHAPE_TERMS = new Set(["triangle", "rectangle", "oval", "ellipse", "star", "hexagon", "pentagon", "diamond"]);
const NON_BLUE_COLOR_TERMS = new Set(["red", "crimson", "scarlet", "green", "yellow", "orange", "purple", "violet", "black", "white", "gray", "grey", "brown", "pink"]);
const NON_RED_COLOR_TERMS = new Set(["blue", "azure", "green", "yellow", "orange", "purple", "violet", "black", "white", "gray", "grey", "brown", "pink"]);
const TOKEN_CANONICALIZATION: Readonly<Record<string, string>> = Object.freeze({
  squares: "square",
  boxes: "box",
  circles: "circle",
  disks: "disk",
  discs: "disc",
  triangles: "triangle",
  rectangles: "rectangle",
  ovals: "oval",
  ellipses: "ellipse",
  stars: "star",
  hexagons: "hexagon",
  pentagons: "pentagon",
  diamonds: "diamond",
});

function normalizeZenVisionProviderText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedTokens(normalized: string): string[] {
  if (!normalized) return [];
  return normalized.split(" ").map((token) => TOKEN_CANONICALIZATION[token] ?? token);
}

function normalizedClauses(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/(?:[,;|/\n]+|[.!?]+|\b(?:and|while|but|actually|however)\b)/g, " || ")
    .split("||")
    .map((clause) => clause.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function tokenPositions(tokens: string[], accepted: ReadonlySet<string>): number[] {
  const positions: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (accepted.has(tokens[index])) positions.push(index);
  }
  return positions;
}

type CategorizedPosition<T extends string> = { index: number; category: T };

function categorizedPositions<T extends string>(
  tokens: string[],
  categories: ReadonlyArray<{ category: T; terms: ReadonlySet<string> }>,
): CategorizedPosition<T>[] {
  const positions: CategorizedPosition<T>[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    for (const entry of categories) {
      if (entry.terms.has(tokens[index])) positions.push({ index, category: entry.category });
    }
  }
  return positions;
}

function nearestCategories<T extends string>(origin: number, candidates: ReadonlyArray<CategorizedPosition<T>>): Set<T> {
  let minimumDistance = Number.POSITIVE_INFINITY;
  const categories = new Set<T>();
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.index - origin);
    if (distance < minimumDistance) {
      minimumDistance = distance;
      categories.clear();
      categories.add(candidate.category);
    } else if (distance === minimumDistance) {
      categories.add(candidate.category);
    }
  }
  return categories;
}

function nearestCategoryIsOnly<T extends string>(origin: number, candidates: ReadonlyArray<CategorizedPosition<T>>, expected: T): boolean {
  const categories = nearestCategories(origin, candidates);
  return categories.size === 1 && categories.has(expected);
}

function entityColorMatched(
  shapePositions: number[],
  colors: ReadonlyArray<CategorizedPosition<"blue" | "red" | "other">>,
  expectedColor: "blue" | "red",
): boolean {
  return shapePositions.some((shapeIndex) => nearestCategoryIsOnly(shapeIndex, colors, expectedColor));
}

function explicitWrongCount(tokens: string[]): boolean {
  const wrongCounts = new Set(["zero", "no", "two", "three", "four", "five", "six", "multiple", "several", "0", "2", "3", "4", "5", "6"]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!wrongCounts.has(tokens[index])) continue;
    const nearby = tokens.slice(index + 1, index + 5);
    if (nearby.some((token) => SQUARE_TERMS.has(token) || CIRCLE_TERMS.has(token))) return true;
  }
  return false;
}

function analyzeZenVisionProviderText(text: string) {
  const normalized = normalizeZenVisionProviderText(text);
  const tokens = normalizedTokens(normalized);
  const clauseTokens = normalizedClauses(text).map(normalizedTokens);

  const analyzeClause = (clause: string[]) => {
    const squarePositions = tokenPositions(clause, SQUARE_TERMS);
    const circlePositions = tokenPositions(clause, CIRCLE_TERMS);
    const colors = categorizedPositions(clause, [
      { category: "blue" as const, terms: BLUE_TERMS },
      { category: "red" as const, terms: RED_TERMS },
      { category: "other" as const, terms: new Set([...NON_BLUE_COLOR_TERMS, ...NON_RED_COLOR_TERMS].filter((term) => !BLUE_TERMS.has(term) && !RED_TERMS.has(term))) },
    ]);
    const shapes = categorizedPositions(clause, [
      { category: "square" as const, terms: SQUARE_TERMS },
      { category: "circle" as const, terms: CIRCLE_TERMS },
      { category: "other" as const, terms: WRONG_SHAPE_TERMS },
    ]);
    const positions = categorizedPositions(clause, [
      { category: "left" as const, terms: LEFT_TERMS },
      { category: "right" as const, terms: RIGHT_TERMS },
    ]);
    const blueSquare = entityColorMatched(squarePositions, colors, "blue");
    const redCircle = entityColorMatched(circlePositions, colors, "red");
    const blueWrongShape = tokenPositions(clause, BLUE_TERMS).some((index) => {
      const nearest = nearestCategories(index, shapes);
      return nearest.size > 0 && !nearest.has("square");
    });
    const redWrongShape = tokenPositions(clause, RED_TERMS).some((index) => {
      const nearest = nearestCategories(index, shapes);
      return nearest.size > 0 && !nearest.has("circle");
    });
    const squareWrongColor = squarePositions.some((index) => {
      const nearest = nearestCategories(index, colors);
      return nearest.size > 0 && !nearest.has("blue");
    });
    const circleWrongColor = circlePositions.some((index) => {
      const nearest = nearestCategories(index, colors);
      return nearest.size > 0 && !nearest.has("red");
    });
    const wrongPosition = squarePositions.some((index) => nearestCategoryIsOnly(index, positions, "right"))
      || circlePositions.some((index) => nearestCategoryIsOnly(index, positions, "left"));
    return { blueSquare, redCircle, blueWrongShape, redWrongShape, squareWrongColor, circleWrongColor, wrongPosition };
  };

  const clauses = clauseTokens.map(analyzeClause);
  const blueSquare = clauses.some((clause) => clause.blueSquare);
  const redCircle = clauses.some((clause) => clause.redCircle);
  const visibleLabel = normalized.includes("uca vision probe 2047");

  const blueWrongShape = clauses.some((clause) => clause.blueWrongShape);
  const redWrongShape = clauses.some((clause) => clause.redWrongShape);
  const squareWrongColor = clauses.some((clause) => clause.squareWrongColor);
  const circleWrongColor = clauses.some((clause) => clause.circleWrongColor);
  const wrongPosition = clauses.some((clause) => clause.wrongPosition);
  const explicitLabelNumbers = [...normalized.matchAll(/\buca vision probe (\d+)\b/g)].map((match) => match[1]);
  const wrongCountOrLabel = explicitWrongCount(tokens) || explicitLabelNumbers.some((number) => number !== "2047");

  const mandatory = [blueSquare, redCircle, visibleLabel];
  const contradictory = [blueWrongShape, redWrongShape, squareWrongColor, circleWrongColor, wrongPosition, wrongCountOrLabel];
  const mandatoryCount = mandatory.filter(Boolean).length;
  const contradictoryCount = contradictory.filter(Boolean).length;

  const unsupportedIndicator = /(?:image|vision|multimodal).{0,40}(?:not supported|unsupported)|(?:text only model)|(?:do not|don t|cannot|can t|unable to).{0,30}(?:support|process).{0,30}(?:image|vision|multimodal)/i.test(normalized);
  const imageIgnoredIndicator = /(?:no|without).{0,20}(?:image|attachment)|(?:image|attachment).{0,30}(?:not provided|not attached|missing|unavailable|not accessible)|(?:cannot|can t|unable to).{0,20}(?:see|view|access).{0,20}(?:image|attachment)/i.test(normalized);
  const refusalIndicator = /\b(?:i refuse|i decline|cannot comply|can t comply|unable to comply|will not comply|won t comply)\b|\bsorry\b.{0,40}\b(?:cannot|can t|unable|decline|refuse)\b/i.test(normalized);
  const genericIndicator = /\b(?:image|picture|graphic|photo)\b.{0,80}\b(?:shape|shapes|color|colors|text|label)\b|\b(?:colored|colourful|colorful) shapes\b/i.test(normalized);

  let semanticClass: ZenVisionProviderOutputClass;
  if (unsupportedIndicator) semanticClass = "explicit_multimodal_unsupported";
  else if (imageIgnoredIndicator) semanticClass = "image_ignored_or_stripped";
  else if (refusalIndicator) semanticClass = "refusal";
  else if (contradictoryCount > 0) semanticClass = "wrong_visual_facts";
  else if (mandatoryCount === mandatory.length) semanticClass = "fixture_recognized";
  else if (mandatoryCount > 0) semanticClass = "fixture_partly_recognized";
  else if (genericIndicator) semanticClass = "generic_visual_prose";
  else semanticClass = "completed_unclassifiable";

  const fixtureRecognitionStatus: ZenVisionFixtureRecognitionStatus = semanticClass === "fixture_recognized"
    ? "recognized"
    : semanticClass === "fixture_partly_recognized"
      ? "partly_recognized"
      : "not_recognized";

  return {
    normalized,
    semanticClass,
    fixtureRecognitionStatus,
    mandatoryFeatureMatchBitmap: mandatory.map((matched) => matched ? "1" : "0").join(""),
    mandatoryFeatureMatchCount: mandatoryCount,
    contradictoryFeatureMatchBitmap: contradictory.map((matched) => matched ? "1" : "0").join(""),
    contradictoryFeatureMatchCount: contradictoryCount,
    refusalIndicator,
    genericIndicator,
    imageIgnoredIndicator,
    unsupportedIndicator,
  };
}

export function classifyZenVisionProviderText(text: string): ZenVisionProviderOutputClass {
  return analyzeZenVisionProviderText(text).semanticClass;
}

export async function inspectZenVisionProviderText(
  text: string,
  evidence: ZenVisionCompletionEvidence = {},
): Promise<ZenVisionSemanticReceipt> {
  const analysis = analyzeZenVisionProviderText(text);
  return {
    version: 1,
    completionStatus: typeof evidence.completionStatus === "string" ? evidence.completionStatus : null,
    requestedOutputCeiling: Number.isFinite(evidence.requestedOutputCeiling) ? Number(evidence.requestedOutputCeiling) : null,
    reportedOutputTokens: Number.isFinite(evidence.reportedOutputTokens) ? Number(evidence.reportedOutputTokens) : null,
    outputTokensReachedRequestedCeiling: typeof evidence.outputTokensReachedRequestedCeiling === "boolean" ? evidence.outputTokensReachedRequestedCeiling : null,
    semanticClass: analysis.semanticClass,
    fixtureRecognitionStatus: analysis.fixtureRecognitionStatus,
    mandatoryFeatureMatchBitmap: analysis.mandatoryFeatureMatchBitmap,
    mandatoryFeatureMatchCount: analysis.mandatoryFeatureMatchCount,
    contradictoryFeatureMatchBitmap: analysis.contradictoryFeatureMatchBitmap,
    contradictoryFeatureMatchCount: analysis.contradictoryFeatureMatchCount,
    refusalIndicator: analysis.refusalIndicator,
    genericIndicator: analysis.genericIndicator,
    imageIgnoredIndicator: analysis.imageIgnoredIndicator,
    unsupportedIndicator: analysis.unsupportedIndicator,
    normalizedOutputSha256: await sha256HexUtf8(analysis.normalized),
    partialOutputPresent: evidence.partialOutputPresent === true || text.trim().length > 0,
  };
}

export function assertZenVisionFixtureRecognition(
  textOrReceipt: string | ZenVisionSemanticReceipt,
): ZenVisionProviderOutputClass {
  const outputClass = typeof textOrReceipt === "string"
    ? classifyZenVisionProviderText(textOrReceipt)
    : textOrReceipt.semanticClass;
  if (outputClass === "fixture_recognized") return outputClass;
  if (outputClass === "explicit_multimodal_unsupported") {
    throw new ConnectorError("provider_multimodal_unsupported", "The provider explicitly reported that multimodal image input is unsupported.");
  }
  if (outputClass === "image_ignored_or_stripped") {
    throw new ConnectorError("provider_image_input_ignored", "The completed provider output indicated that the image input was absent, stripped, or inaccessible.");
  }
  if (outputClass === "refusal") {
    throw new ConnectorError("provider_visual_fixture_refused", "The completed provider output refused the bounded visual fixture request.");
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
