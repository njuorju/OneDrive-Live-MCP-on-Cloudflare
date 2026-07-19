const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".emf": "image/emf",
  ".wmf": "image/wmf",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".potx": "application/vnd.openxmlformats-officedocument.presentationml.template",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".log": "text/plain",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".sql": "application/sql",
  ".ps1": "text/plain",
  ".bat": "text/plain",
  ".cmd": "text/plain",
  ".sh": "application/x-sh",
  ".r": "text/plain",
};

export const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".log", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css",
  ".html", ".htm", ".xml", ".sql", ".ps1", ".bat", ".cmd", ".sh", ".r",
]);

export const DIRECT_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
export const CONVERTIBLE_IMAGE_EXTENSIONS = new Set([
  ".heic", ".heif", ".tif", ".tiff", ".bmp", ".svg", ".emf", ".wmf",
]);
export const VISUAL_EXTENSIONS = new Set([...DIRECT_IMAGE_EXTENSIONS, ...CONVERTIBLE_IMAGE_EXTENSIONS]);
export const ORIGINAL_FILE_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

const OFFICE_EXTENSIONS = new Set([".pptx", ".potx", ".docx", ".xlsx"]);

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLocaleLowerCase("en") : "";
}

export function normalizedMimeType(name: string, graphMime?: string | null): string {
  const extension = extensionOf(name);
  const expected = MIME_BY_EXTENSION[extension];
  if (expected) return expected;
  const candidate = String(graphMime ?? "").trim().toLocaleLowerCase("en");
  return candidate || "application/octet-stream";
}

function startsWith(bytes: Uint8Array, expected: number[], offset = 0): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes.slice(start, start + length));
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  if (needle.length === 0 || bytes.length < needle.length) return false;
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  if (sample.some((value) => value === 0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function officePackageMatches(extension: string, bytes: Uint8Array): boolean {
  if (!containsAscii(bytes, "[Content_Types].xml")) return false;
  if (extension === ".pptx" || extension === ".potx") {
    return containsAscii(bytes, "ppt/presentation.xml");
  }
  if (extension === ".docx") return containsAscii(bytes, "word/document.xml");
  if (extension === ".xlsx") return containsAscii(bytes, "xl/workbook.xml");
  return false;
}

function canonicalUpstreamMime(value: string): string {
  const mime = value.split(";", 1)[0].trim().toLocaleLowerCase("en");
  if (mime === "image/jpg" || mime === "image/pjpeg") return "image/jpeg";
  if (mime === "image/x-png") return "image/png";
  if (mime === "image/x-tiff") return "image/tiff";
  if (mime === "application/x-pdf") return "application/pdf";
  return mime;
}

function upstreamMimeCompatible(
  extension: string,
  expected: string,
  graphMime?: string | null,
): boolean {
  const upstream = canonicalUpstreamMime(String(graphMime ?? ""));
  if (!upstream || upstream === "application/octet-stream" || upstream === "binary/octet-stream") {
    return true;
  }
  if (upstream === expected) return true;
  if ((extension === ".heic" || extension === ".heif") && (upstream === "image/heic" || upstream === "image/heif")) {
    return true;
  }
  if (OFFICE_EXTENSIONS.has(extension) && (upstream === "application/zip" || upstream === "application/x-zip-compressed")) {
    return true;
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    if (upstream.startsWith("text/")) return true;
    if ([
      "application/json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/toml",
      "application/sql",
      "application/javascript",
      "application/typescript",
      "application/x-sh",
    ].includes(upstream)) return true;
    if (extension === ".csv" && upstream === "application/vnd.ms-excel") return true;
  }
  if (extension === ".svg" && upstream === "text/plain") return true;
  return false;
}

export type SignatureResult = {
  detected: string;
  compatible: boolean;
  reason?: string;
};

export function validateFileSignature(
  filename: string,
  buffer: ArrayBuffer,
  graphMime?: string | null,
): SignatureResult {
  const extension = extensionOf(filename);
  const bytes = new Uint8Array(buffer);
  const mime = normalizedMimeType(filename, graphMime);
  if (!upstreamMimeCompatible(extension, mime, graphMime)) {
    return {
      detected: "upstream-mime-conflict",
      compatible: false,
      reason: `File extension indicates ${mime}, but Microsoft metadata indicates ${canonicalUpstreamMime(String(graphMime))}.`,
    };
  }

  let detected = "unknown";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) detected = "image/jpeg";
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) detected = "image/png";
  else if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") detected = "image/gif";
  else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") detected = "image/webp";
  else if (startsWith(bytes, [0x42, 0x4d])) detected = "image/bmp";
  else if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) detected = "image/tiff";
  else if (startsWith(bytes, [0x49, 0x49, 0x2b, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2b])) detected = "image/tiff";
  else if (
    ascii(bytes, 4, 4) === "ftyp" &&
    /(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)/i.test(ascii(bytes, 8, 24))
  ) detected = "image/heif";
  else if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) detected = "application/pdf";
  else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) detected = "application/zip";
  else if (
    startsWith(bytes, [0xd7, 0xcd, 0xc6, 0x9a]) ||
    startsWith(bytes, [0x01, 0x00, 0x09, 0x00]) ||
    startsWith(bytes, [0x02, 0x00, 0x09, 0x00])
  ) detected = "image/wmf";
  else if (bytes.length >= 44 && startsWith(bytes, [0x01, 0x00, 0x00, 0x00]) && ascii(bytes, 40, 4) === " EMF") detected = "image/emf";
  else if (looksLikeUtf8Text(bytes)) {
    const prefix = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(0, Math.min(bytes.length, 4096)))
      .trimStart();
    detected = /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(prefix) ? "image/svg+xml" : "text/plain";
  }

  const compatible =
    mime === detected ||
    (mime === "image/heic" && detected === "image/heif") ||
    (mime === "image/heif" && detected === "image/heif") ||
    (OFFICE_EXTENSIONS.has(extension) && detected === "application/zip" && officePackageMatches(extension, bytes)) ||
    (TEXT_EXTENSIONS.has(extension) && detected === "text/plain");

  return compatible
    ? { detected, compatible: true }
    : {
        detected,
        compatible: false,
        reason: `File extension/MIME indicates ${mime}, but signature indicates ${detected}.`,
      };
}

export function isVisualAsset(name: string): boolean {
  return VISUAL_EXTENSIONS.has(extensionOf(name));
}

export function isDirectImage(name: string): boolean {
  return DIRECT_IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isConvertibleImage(name: string): boolean {
  return CONVERTIBLE_IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isAllowedOriginalFile(name: string): boolean {
  return ORIGINAL_FILE_EXTENSIONS.has(extensionOf(name));
}

export function isAllowedTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(name));
}
