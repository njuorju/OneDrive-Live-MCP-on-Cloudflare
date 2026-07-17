import { strFromU8, unzipSync } from "fflate";

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function xmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<a:br\s*\/?\s*>/gi, "\n")
    .replace(/<w:br\s*\/?\s*>/gi, "\n")
    .replace(/<\/a:p>/gi, "\n")
    .replace(/<\/p:txBody>/gi, "\n")
    .replace(/<\/a:tr>/gi, "\n")
    .replace(/<\/a:tc>/gi, "\t");

  const textRuns = Array.from(
    withBreaks.matchAll(/<(?:a:t|w:t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:a:t|w:t)>/gi),
    (match) => decodeXmlEntities(match[1]),
  );

  if (textRuns.length > 0) {
    return textRuns.join(" ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  return decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function numericOrder(path: string): number {
  const match = path.match(/(\d+)\.xml$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function extractPptxText(buffer: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  const slideNames = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => numericOrder(a) - numericOrder(b));
  const noteNames = Object.keys(files)
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name))
    .sort((a, b) => numericOrder(a) - numericOrder(b));

  const notesByNumber = new Map<number, string>();
  for (const name of noteNames) {
    notesByNumber.set(numericOrder(name), xmlToText(strFromU8(files[name])));
  }

  const sections: string[] = [];
  for (const name of slideNames) {
    const number = numericOrder(name);
    const slideText = xmlToText(strFromU8(files[name]));
    const notes = notesByNumber.get(number);
    sections.push(
      [`## Slide ${number}`, slideText, notes ? `### Speaker notes\n${notes}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return sections.join("\n\n---\n\n");
}
