import { unzipSync, unzlibSync } from "fflate";

export const INTEGRATED_LIMITS = {
  snapshotItemsDefault: 1_000,
  snapshotItemsMax: 5_000,
  recursionDepthDefault: 64,
  recursionDepthMax: 128,
  fileBytesDefault: 25 * 1024 * 1024,
  fileBytesMax: 100 * 1024 * 1024,
  normalizedTextCharsMax: 2_000_000,
  ooxmlEntriesMax: 8_000,
  ooxmlCompressedBytesMax: 50 * 1024 * 1024,
  ooxmlUncompressedBytesMax: 250 * 1024 * 1024,
  ooxmlCompressionRatioMax: 200,
  pdfPagesMax: 500,
  slidesMax: 500,
  renderDimensionMax: 4_096,
  visualCountMax: 1_000,
  contactSheetItemsMax: 64,
  hashBatchMax: 100,
  jobRetentionSeconds: 86_400,
  snapshotRetentionSeconds: 86_400,
  planRetentionSeconds: 86_400,
  executionTokenSeconds: 900,
  retriesMax: 3,
} as const;

export type HtmlDiagnostics = {
  visibleBodyTextLength: number;
  scriptTextLength: number;
  scriptTagCount: number;
  emptyApplicationRoots: string[];
  openGraphOnlyMetadata: boolean;
  meaningfulOfflineSubstantiveText: boolean;
  likelyJavaScriptShell: boolean;
};

export type NormalizedTextResult = {
  normalizedText: string;
  extractedCharacterCount: number;
  representationStatus: "text_readable" | "image_only_or_unextractable";
  explanation?: string;
};

export type OoxmlEntryMap = Record<string, Uint8Array>;

export type DocumentVisualCandidate = {
  visualKey: string;
  pageOrSlide: number | null;
  objectType: string;
  relationshipId: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  coordinates: { x?: number; y?: number; width?: number; height?: number } | null;
  caption: string | null;
  nearbyHeading: string | null;
  altText: string | null;
  title: string | null;
  description: string | null;
  sourceHyperlink: string | null;
  exactOriginalAvailable: boolean;
  renderAvailable: boolean;
  extractionMethod: string;
  completenessConfidence: "high" | "medium" | "low";
  locator: Record<string, unknown>;
};

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

export function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const owned = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)));
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(encoder.encode(value));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

export function stripXml(value: string): string {
  return decodeEntities(
    value
      .replace(/<w:tab\s*\/>/gi, "\t")
      .replace(/<w:br\s*\/?>/gi, "\n")
      .replace(/<a:br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function normalizeExtractedText(input: string): NormalizedTextResult {
  let text = input.replace(/^\uFEFF/, "").normalize("NFKC").replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((line) => line.replace(/[\t\u00a0 ]+/g, " ").trim());
  const frequency = new Map<string, number>();
  for (const line of lines) {
    if (line && line.length <= 160) frequency.set(line, (frequency.get(line) ?? 0) + 1);
  }
  const repeatedArtifacts = new Set(
    [...frequency.entries()]
      .filter(([line, count]) => count >= 4 && /^(page\s*)?\d+(\s*(of|\/|из)\s*\d+)?$/i.test(line))
      .map(([line]) => line),
  );
  const normalizedLines: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (normalizedLines.at(-1) !== "") normalizedLines.push("");
      continue;
    }
    if (/^(page\s*)?\d+(\s*(of|\/|из)\s*\d+)?$/i.test(line)) continue;
    if (repeatedArtifacts.has(line)) continue;
    normalizedLines.push(line);
  }
  text = normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  if (!text) {
    return {
      normalizedText: "",
      extractedCharacterCount: input.length,
      representationStatus: "image_only_or_unextractable",
      explanation: "No substantive text remained after deterministic normalization.",
    };
  }
  return {
    normalizedText: text,
    extractedCharacterCount: input.length,
    representationStatus: "text_readable",
  };
}

export function inspectHtml(html: string): HtmlDiagnostics {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const scriptTextLength = scripts.reduce((sum, match) => sum + stripXml(match[1] ?? "").length, 0);
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(withoutNoise)?.[1] ?? withoutNoise;
  const visible = stripXml(body);
  const emptyApplicationRoots: string[] = [];
  for (const match of html.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div>/gi)) {
    const attrs = match[1] ?? "";
    const inner = stripXml(match[2] ?? "");
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (id && !inner && /^(root|app|application|__next|svelte)$/i.test(id)) emptyApplicationRoots.push(id);
  }
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const openGraphCount = metaTags.filter((tag) => /\bproperty\s*=\s*["']og:/i.test(tag)).length;
  const substantiveMetaCount = metaTags.filter((tag) => /\bname\s*=\s*["'](description|author|keywords)["']/i.test(tag)).length;
  const meaningful = visible.length >= 500 || (visible.length >= 200 && /\b(article|section|main|глава|статья|раздел)\b/i.test(withoutNoise));
  const likelyShell = !meaningful && scripts.length > 0 && (emptyApplicationRoots.length > 0 || visible.length < 120);
  return {
    visibleBodyTextLength: visible.length,
    scriptTextLength,
    scriptTagCount: scripts.length,
    emptyApplicationRoots,
    openGraphOnlyMetadata: openGraphCount > 0 && substantiveMetaCount === 0 && visible.length < 200,
    meaningfulOfflineSubstantiveText: meaningful,
    likelyJavaScriptShell: likelyShell,
  };
}

function entryNameSafe(name: string): boolean {
  if (!name || name.startsWith("/") || /^[a-z]:/i.test(name) || name.includes("\\")) return false;
  const segments = name.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

export function safeUnzipOoxml(buffer: ArrayBuffer): OoxmlEntryMap {
  if (buffer.byteLength > INTEGRATED_LIMITS.ooxmlCompressedBytesMax) {
    throw new Error("OOXML package exceeds the compressed-size limit.");
  }
  const entries = unzipSync(new Uint8Array(buffer));
  const names = Object.keys(entries);
  if (names.length > INTEGRATED_LIMITS.ooxmlEntriesMax) throw new Error("OOXML package contains too many entries.");
  let total = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (!entryNameSafe(name)) throw new Error("OOXML package contains an unsafe ZIP path.");
    total += bytes.byteLength;
    if (total > INTEGRATED_LIMITS.ooxmlUncompressedBytesMax) {
      throw new Error("OOXML package exceeds the uncompressed-size limit.");
    }
  }
  if (buffer.byteLength > 0 && total / buffer.byteLength > INTEGRATED_LIMITS.ooxmlCompressionRatioMax) {
    throw new Error("OOXML package exceeds the compression-ratio limit.");
  }
  if (!entries["[Content_Types].xml"]) throw new Error("OOXML package is malformed.");
  return entries;
}

export function xmlText(entries: OoxmlEntryMap, name: string): string {
  const value = entries[name];
  return value ? decoder.decode(value) : "";
}

function attr(tag: string, name: string): string | null {
  const expression = new RegExp(`\\b${name.replace(":", "\\:")}\\s*=\\s*["']([^"']*)["']`, "i");
  return expression.exec(tag)?.[1] ?? null;
}

function normalizeZipTarget(basePath: string, target: string): string {
  const cleanTarget = target.replace(/\\/g, "/");
  const base = basePath.split("/");
  base.pop();
  for (const segment of cleanTarget.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}

export function parseRelationships(xml: string, basePath: string): Map<string, { target: string; type: string; external: boolean }> {
  const relationships = new Map<string, { target: string; type: string; external: boolean }>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
    const tag = match[0];
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    const type = attr(tag, "Type") ?? "";
    if (!id || !target) continue;
    const external = /\bTargetMode\s*=\s*["']External["']/i.test(tag);
    relationships.set(id, { target: external ? target : normalizeZipTarget(basePath, target), type, external });
  }
  return relationships;
}

function mimeFromName(name: string): string {
  const extension = name.toLocaleLowerCase("en").split(".").pop() ?? "";
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", emf: "image/emf", wmf: "image/wmf", tif: "image/tiff", tiff: "image/tiff",
    bmp: "image/bmp", heic: "image/heic", heif: "image/heif",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function textRuns(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<(?:a:t|w:t)\b[^>]*>([\s\S]*?)<\/(?:a:t|w:t)>/gi)) {
    const value = decodeEntities(match[1] ?? "").trim();
    if (value) values.push(value);
  }
  return values;
}

function nearestHeading(paragraphs: Array<{ index: number; text: string; style: string | null }>, index: number): string | null {
  for (let cursor = paragraphs.length - 1; cursor >= 0; cursor -= 1) {
    const paragraph = paragraphs[cursor];
    if (paragraph.index >= index) continue;
    if (paragraph.style && /^(heading|title|заголовок)/i.test(paragraph.style)) return paragraph.text || null;
  }
  return null;
}

export function inspectPptx(entries: OoxmlEntryMap): {
  pageCount: number;
  embeddedImageCount: number;
  visuals: DocumentVisualCandidate[];
  text: string;
  metadata: Record<string, unknown>;
} {
  const slideNames = Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/slide(\d+)/i.exec(a)?.[1]) - Number(/slide(\d+)/i.exec(b)?.[1]));
  if (slideNames.length > INTEGRATED_LIMITS.slidesMax) throw new Error("PowerPoint exceeds the slide-count limit.");
  const visuals: DocumentVisualCandidate[] = [];
  const allText: string[] = [];
  for (const slideName of slideNames) {
    const slideNumber = Number(/slide(\d+)/i.exec(slideName)?.[1] ?? 0);
    const slideXml = xmlText(entries, slideName);
    const relName = slideName.replace("/slides/", "/slides/_rels/") + ".rels";
    const relationships = parseRelationships(xmlText(entries, relName), slideName);
    const runs = textRuns(slideXml);
    if (runs.length) allText.push(`Slide ${slideNumber}\n${runs.join("\n")}`);
    const title = runs[0] ?? null;
    const mediaUsages = new Map<string, number>();
    for (const match of slideXml.matchAll(/<a:blip\b[^>]*(?:r:embed|r:link)\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi)) {
      const relationshipId = match[1];
      const relation = relationships.get(relationshipId);
      if (!relation || relation.external) continue;
      const mediaPath = relation.target;
      if (!entries[mediaPath]) continue;
      const usage = mediaUsages.get(relationshipId) ?? 0;
      mediaUsages.set(relationshipId, usage + 1);
      const start = Math.max(0, (match.index ?? 0) - 1500);
      const end = Math.min(slideXml.length, (match.index ?? 0) + match[0].length + 1500);
      const context = slideXml.slice(start, end);
      const cNvPr = [...context.matchAll(/<(?:p|pic|a):cNvPr\b[^>]*>/gi)].at(-1)?.[0] ?? "";
      const objectName = attr(cNvPr, "name");
      const descr = attr(cNvPr, "descr");
      const objectTitle = attr(cNvPr, "title");
      const hyperlinkRel = /<a:hlinkClick\b[^>]*r:id\s*=\s*["']([^"']+)["']/i.exec(context)?.[1] ?? null;
      const hyperlink = hyperlinkRel ? relationships.get(hyperlinkRel) : null;
      const originalFilename = mediaPath.split("/").pop() ?? null;
      visuals.push({
        visualKey: `pptx:slide:${slideNumber}:rel:${relationshipId}:usage:${usage}`,
        pageOrSlide: slideNumber,
        objectType: "embedded_image",
        relationshipId,
        originalFilename,
        mimeType: originalFilename ? mimeFromName(originalFilename) : null,
        pixelWidth: null,
        pixelHeight: null,
        coordinates: null,
        caption: null,
        nearbyHeading: title,
        altText: descr,
        title: objectTitle ?? objectName,
        description: descr,
        sourceHyperlink: hyperlink?.external ? hyperlink.target : null,
        exactOriginalAvailable: true,
        renderAvailable: true,
        extractionMethod: "ooxml_relationship",
        completenessConfidence: "high",
        locator: { kind: "ooxml_entry", entry: mediaPath },
      });
    }
    const compositeSignals: Array<[RegExp, string]> = [
      [/<p:grpSp\b/i, "grouped_shapes"],
      [/<c:chart\b|\/chart"/i, "chart"],
      [/\/diagramData"|\/diagramLayout"/i, "smartart"],
      [/<p:graphicFrame\b/i, "graphic_frame"],
    ];
    for (const [pattern, objectType] of compositeSignals) {
      if (!pattern.test(slideXml) && ![...relationships.values()].some((relation) => pattern.test(relation.type))) continue;
      visuals.push({
        visualKey: `pptx:slide:${slideNumber}:composite:${objectType}`,
        pageOrSlide: slideNumber,
        objectType,
        relationshipId: null,
        originalFilename: null,
        mimeType: null,
        pixelWidth: null,
        pixelHeight: null,
        coordinates: null,
        caption: null,
        nearbyHeading: title,
        altText: null,
        title,
        description: null,
        sourceHyperlink: null,
        exactOriginalAvailable: false,
        renderAvailable: true,
        extractionMethod: "ooxml_composite_detection",
        completenessConfidence: "medium",
        locator: { kind: "render_page", page: slideNumber },
      });
    }
  }
  const core = xmlText(entries, "docProps/core.xml");
  return {
    pageCount: slideNames.length,
    embeddedImageCount: visuals.filter((visual) => visual.exactOriginalAvailable).length,
    visuals,
    text: allText.join("\n\n"),
    metadata: {
      title: stripXml(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(core)?.[1] ?? "") || null,
      author: stripXml(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(core)?.[1] ?? "") || null,
      created: /<dcterms:created\b[^>]*>([^<]+)</i.exec(core)?.[1] ?? null,
      modified: /<dcterms:modified\b[^>]*>([^<]+)</i.exec(core)?.[1] ?? null,
    },
  };
}

export function inspectDocx(entries: OoxmlEntryMap): {
  pageCount: number | null;
  embeddedImageCount: number;
  visuals: DocumentVisualCandidate[];
  text: string;
  metadata: Record<string, unknown>;
  headings: string[];
  captions: string[];
  hyperlinks: string[];
} {
  const documentXml = xmlText(entries, "word/document.xml");
  if (!documentXml) throw new Error("DOCX package does not contain word/document.xml.");
  const rels = parseRelationships(xmlText(entries, "word/_rels/document.xml.rels"), "word/document.xml");
  const paragraphs: Array<{ index: number; text: string; style: string | null }> = [];
  let paragraphIndex = 0;
  for (const match of documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gi)) {
    const xml = match[0];
    const style = /<w:pStyle\b[^>]*w:val\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1] ?? null;
    paragraphs.push({ index: match.index ?? paragraphIndex++, text: textRuns(xml).join(" ").trim(), style });
  }
  const headings = paragraphs.filter((paragraph) => paragraph.style && /^(heading|title|заголовок)/i.test(paragraph.style)).map((paragraph) => paragraph.text).filter(Boolean);
  const captions = paragraphs.filter((paragraph) => paragraph.style && /caption|подпись/i.test(paragraph.style)).map((paragraph) => paragraph.text).filter(Boolean);
  const visuals: DocumentVisualCandidate[] = [];
  const usages = new Map<string, number>();
  for (const match of documentXml.matchAll(/<a:blip\b[^>]*(?:r:embed|r:link)\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi)) {
    const relationshipId = match[1];
    const relation = rels.get(relationshipId);
    if (!relation || relation.external || !entries[relation.target]) continue;
    const usage = usages.get(relationshipId) ?? 0;
    usages.set(relationshipId, usage + 1);
    const offset = match.index ?? 0;
    const nearestParagraph = paragraphs.filter((paragraph) => paragraph.index <= offset).at(-1);
    const nextParagraph = paragraphs.find((paragraph) => paragraph.index > offset && paragraph.text);
    const caption = nextParagraph?.style && /caption|подпись/i.test(nextParagraph.style) ? nextParagraph.text : null;
    const context = documentXml.slice(Math.max(0, offset - 1200), Math.min(documentXml.length, offset + match[0].length + 1200));
    const docPr = /<wp:docPr\b[^>]*>/i.exec(context)?.[0] ?? "";
    const originalFilename = relation.target.split("/").pop() ?? null;
    visuals.push({
      visualKey: `docx:rel:${relationshipId}:usage:${usage}`,
      pageOrSlide: null,
      objectType: "embedded_image",
      relationshipId,
      originalFilename,
      mimeType: originalFilename ? mimeFromName(originalFilename) : null,
      pixelWidth: null,
      pixelHeight: null,
      coordinates: null,
      caption,
      nearbyHeading: nearestHeading(paragraphs, offset),
      altText: attr(docPr, "descr"),
      title: attr(docPr, "title") ?? attr(docPr, "name"),
      description: attr(docPr, "descr"),
      sourceHyperlink: null,
      exactOriginalAvailable: true,
      renderAvailable: true,
      extractionMethod: "ooxml_relationship",
      completenessConfidence: "high",
      locator: { kind: "ooxml_entry", entry: relation.target },
    });
  }
  const hyperlinks = [...rels.values()].filter((relationship) => relationship.external && /hyperlink/i.test(relationship.type)).map((relationship) => relationship.target);
  const core = xmlText(entries, "docProps/core.xml");
  const app = xmlText(entries, "docProps/app.xml");
  const pagesRaw = /<Pages>(\d+)<\/Pages>/i.exec(app)?.[1];
  return {
    pageCount: pagesRaw ? Number(pagesRaw) : null,
    embeddedImageCount: visuals.length,
    visuals,
    text: paragraphs.map((paragraph) => paragraph.text).filter(Boolean).join("\n"),
    headings,
    captions,
    hyperlinks,
    metadata: {
      title: stripXml(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(core)?.[1] ?? "") || null,
      author: stripXml(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(core)?.[1] ?? "") || null,
      created: /<dcterms:created\b[^>]*>([^<]+)</i.exec(core)?.[1] ?? null,
      modified: /<dcterms:modified\b[^>]*>([^<]+)</i.exec(core)?.[1] ?? null,
      application: stripXml(/<Application>([\s\S]*?)<\/Application>/i.exec(app)?.[1] ?? "") || null,
    },
  };
}

export function inspectPdfBytes(buffer: ArrayBuffer): {
  pageCount: number;
  visuals: DocumentVisualCandidate[];
  title: string | null;
  author: string | null;
} {
  const bytes = new Uint8Array(buffer);
  const binary = new TextDecoder("latin1").decode(bytes);
  const pageCount = Math.min(
    INTEGRATED_LIMITS.pdfPagesMax,
    [...binary.matchAll(/\/Type\s*\/Page\b/g)].length || Number(/\/Count\s+(\d+)/.exec(binary)?.[1] ?? 1),
  );
  const visuals: DocumentVisualCandidate[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    visuals.push({
      visualKey: `pdf:page:${page}`,
      pageOrSlide: page,
      objectType: "pdf_page",
      relationshipId: null,
      originalFilename: null,
      mimeType: null,
      pixelWidth: null,
      pixelHeight: null,
      coordinates: null,
      caption: null,
      nearbyHeading: null,
      altText: null,
      title: null,
      description: null,
      sourceHyperlink: null,
      exactOriginalAvailable: false,
      renderAvailable: true,
      extractionMethod: "pdf_page_inventory",
      completenessConfidence: "medium",
      locator: { kind: "render_page", page },
    });
  }
  let imageIndex = 0;
  for (const match of binary.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) {
    const body = match[3] ?? "";
    if (!/\/Subtype\s*\/Image\b/.test(body) || !/\/Filter\s*(?:\[\s*)?\/DCTDecode\b/.test(body)) continue;
    const streamMarker = /stream\r?\n/g.exec(body);
    const endMarker = body.lastIndexOf("endstream");
    if (!streamMarker || endMarker <= streamMarker.index) continue;
    const absoluteBodyStart = (match.index ?? 0) + match[0].indexOf(body);
    const start = absoluteBodyStart + streamMarker.index + streamMarker[0].length;
    const end = absoluteBodyStart + endMarker;
    if (start < 0 || end > bytes.length || end <= start) continue;
    const width = Number(/\/Width\s+(\d+)/.exec(body)?.[1] ?? 0) || null;
    const height = Number(/\/Height\s+(\d+)/.exec(body)?.[1] ?? 0) || null;
    visuals.push({
      visualKey: `pdf:image:${imageIndex}`,
      pageOrSlide: null,
      objectType: "embedded_raster",
      relationshipId: null,
      originalFilename: `pdf-image-${imageIndex + 1}.jpg`,
      mimeType: "image/jpeg",
      pixelWidth: width,
      pixelHeight: height,
      coordinates: null,
      caption: null,
      nearbyHeading: null,
      altText: null,
      title: null,
      description: null,
      sourceHyperlink: null,
      exactOriginalAvailable: true,
      renderAvailable: true,
      extractionMethod: "pdf_dct_stream",
      completenessConfidence: "medium",
      locator: { kind: "pdf_range", start, end, index: imageIndex },
    });
    imageIndex += 1;
  }
  return {
    pageCount,
    visuals,
    title: /\/Title\s*\(([^)]*)\)/.exec(binary)?.[1] ?? null,
    author: /\/Author\s*\(([^)]*)\)/.exec(binary)?.[1] ?? null,
  };
}

export function extractVisualBytes(buffer: ArrayBuffer, entries: OoxmlEntryMap | null, locator: Record<string, unknown>): Uint8Array | null {
  if (locator.kind === "ooxml_entry" && typeof locator.entry === "string" && entries?.[locator.entry]) {
    return entries[locator.entry];
  }
  if (locator.kind === "pdf_range" && Number.isInteger(locator.start) && Number.isInteger(locator.end)) {
    const start = Number(locator.start);
    const end = Number(locator.end);
    if (start >= 0 && end > start && end <= buffer.byteLength) return new Uint8Array(buffer).slice(start, end);
  }
  return null;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  const headers = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown) => {
    const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(quote).join(","), ...rows.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\r\n");
}

export function extensionOfName(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLocaleLowerCase("en") : "";
}

export function baseNameForWork(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[_\-–—.]+/g, " ")
    .replace(/\b(copy|копия|final|финал|scan|скан|ocr|converted|конвертирован(?:о|ный))\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hammingDistanceHex(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let xor = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function pngDifferenceHash(png: Uint8Array): string {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => png[index] === value)) throw new Error("Perceptual hash requires PNG input.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= png.length) {
    const length = readUint32(png, offset);
    const type = decoder.decode(png.slice(offset + 4, offset + 8));
    const data = png.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width !== 9 || height !== 8 || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error("Perceptual-hash PNG must be an un-interlaced 9x8 8-bit image.");
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const merged = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) {
    merged.set(part, cursor);
    cursor += part.length;
  }
  const inflated = unzlibSync(merged);
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const raw = inflated.slice(inputOffset, inputOffset + stride);
    inputOffset += stride;
    const previous = rows[y - 1] ?? new Uint8Array(stride);
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] ?? 0;
      const upperLeft = x >= channels ? previous[x - channels] ?? 0 : 0;
      const value = raw[x];
      row[x] = filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up : filter === 3 ? value + Math.floor((left + up) / 2) : value + paeth(left, up, upperLeft);
    }
    rows.push(row);
  }
  let bits = "";
  for (const row of rows) {
    const luminance: number[] = [];
    for (let x = 0; x < width; x += 1) {
      const index = x * channels;
      const red = row[index];
      const green = channels >= 3 ? row[index + 1] : red;
      const blue = channels >= 3 ? row[index + 2] : red;
      luminance.push(Math.round(red * 0.299 + green * 0.587 + blue * 0.114));
    }
    for (let x = 0; x < 8; x += 1) bits += luminance[x] > luminance[x + 1] ? "1" : "0";
  }
  let hex = "";
  for (let index = 0; index < bits.length; index += 4) hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  return hex;
}
