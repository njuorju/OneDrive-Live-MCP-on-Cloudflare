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
  let detected = "unknown";

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) detected = "image/jpeg";
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) detected = "image/png";
  else if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") detected = "image/gif";
  else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") detected = "image/webp";
  else if (startsWith(bytes, [0x42, 0x4d])) detected = "image/bmp";
  else if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) detected = "image/tiff";
  else if (startsWith(bytes, [0x49, 0x49, 0x2b, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2b])) detected = "image/tiff";
  else if (ascii(bytes, 4, 4) === "ftyp" && /hei[cfx]|mif1|msf1/i.test(ascii(bytes, 8, 16))) detected = "image/heif";
  else if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) detected = "application/pdf";
  else if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) detected = "application/zip";
  else if (startsWith(bytes, [0xd7, 0xcd, 0xc6, 0x9a])) detected = "image/wmf";
  else if (bytes.length >= 44 && startsWith(bytes, [0x01, 0x00, 0x00, 0x00]) && ascii(bytes, 40, 4) === " EMF") detected = "image/emf";
  else if (looksLikeUtf8Text(bytes)) {
    const prefix = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, Math.min(bytes.length, 4096))).trimStart();
    detected = /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(prefix) ? "image/svg+xml" : "text/plain";
  }

  const zipOffice = new Set([".pptx", ".potx", ".docx", ".xlsx"]);
  const compatible =
    (mime === detected) ||
    (mime === "image/heic" && detected === "image/heif") ||
    (mime === "image/heif" && detected === "image/heif") ||
    (zipOffice.has(extension) && detected === "application/zip") ||
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
