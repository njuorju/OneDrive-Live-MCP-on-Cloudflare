import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, zlibSync } from 'fflate';
import {
  baseNameForWork,
  extractVisualBytes,
  hammingDistanceHex,
  inspectDocx,
  inspectHtml,
  inspectPdfBytes,
  inspectPptx,
  normalizeExtractedText,
  parseCsv,
  pngDifferenceHash,
  safeUnzipOoxml,
  sha256Text,
  toCsv,
} from '../src/integrated-core.js';

const enc = new TextEncoder();
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

function packageZip(entries: Record<string, string | Uint8Array>): ArrayBuffer {
  return ab(zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, typeof value === 'string' ? enc.encode(value) : value]))));
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function u32(value: number): Uint8Array { return new Uint8Array([(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255]); }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = enc.encode(type); const crcInput = new Uint8Array(typeBytes.length + data.length); crcInput.set(typeBytes); crcInput.set(data,typeBytes.length);
  const out = new Uint8Array(12 + data.length); out.set(u32(data.length),0); out.set(typeBytes,4); out.set(data,8); out.set(u32(crc32(crcInput)),8+data.length); return out;
}
function makeGray9x8Png(reverse = false): Uint8Array {
  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const ihdr = new Uint8Array(13); ihdr.set(u32(9),0); ihdr.set(u32(8),4); ihdr[8]=8; ihdr[9]=0;
  const raw = new Uint8Array(8*(1+9)); let k=0;
  for(let y=0;y<8;y++){ raw[k++]=0; for(let x=0;x<9;x++) raw[k++]=reverse?x*28:255-x*28; }
  const chunks=[chunk('IHDR',ihdr),chunk('IDAT',zlibSync(raw)),chunk('IEND',new Uint8Array())];
  const total=signature.length+chunks.reduce((n,c)=>n+c.length,0); const out=new Uint8Array(total); let o=0; out.set(signature,o);o+=signature.length;for(const c of chunks){out.set(c,o);o+=c.length;} return out;
}

test('normalization is stable across Unicode, whitespace, BOM and page numbers', async () => {
  const a = normalizeExtractedText('\uFEFFTitle\r\n\r\nBody   text\r\n1\r\n');
  const b = normalizeExtractedText('Title\n\nBody text\nPage 1\n');
  assert.equal(a.normalizedText, b.normalizedText);
  assert.equal(await sha256Text(a.normalizedText), await sha256Text(b.normalizedText));
});

test('HTML diagnostics distinguish substantive text and JavaScript shell', () => {
  const shell = inspectHtml('<html><head><meta property="og:title" content="Law"><script>boot()</script></head><body><div id="root"></div></body></html>');
  assert.equal(shell.likelyJavaScriptShell, true);
  assert.equal(shell.openGraphOnlyMetadata, true);
  const substantive = inspectHtml(`<main><article>${'Substantive legal text '.repeat(35)}</article></main>`);
  assert.equal(substantive.meaningfulOfflineSubstantiveText, true);
  assert.equal(substantive.likelyJavaScriptShell, false);
});

test('OOXML rejects traversal and extreme compression', () => {
  assert.throws(() => safeUnzipOoxml(packageZip({'[Content_Types].xml':'<Types/>','../evil.txt':'x'})), /unsafe ZIP path/);
  assert.throws(() => safeUnzipOoxml(packageZip({'[Content_Types].xml':'<Types/>','word/document.xml':'A'.repeat(2_000_000)})), /compression-ratio/);
});

test('PPTX inspection maps media, alt text, hyperlinks and composite visuals', () => {
  const slide = `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="2" name="Map" descr="Alt map" title="Source map"><a:hlinkClick r:id="rId2"/></p:cNvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic><p:grpSp/><a:t>Slide title</a:t></p:spTree></p:cSld></p:sld>`;
  const rels = `<Relationships><Relationship Id="rId1" Type="image" Target="../media/image1.png"/><Relationship Id="rId2" Type="hyperlink" Target="https://example.test/source" TargetMode="External"/></Relationships>`;
  const entries = safeUnzipOoxml(packageZip({'[Content_Types].xml':'<Types/>','ppt/slides/slide1.xml':slide,'ppt/slides/_rels/slide1.xml.rels':rels,'ppt/media/image1.png':makeGray9x8Png(),'docProps/core.xml':'<cp><dc:title>Deck</dc:title><dc:creator>Author</dc:creator></cp>'}));
  const result = inspectPptx(entries);
  assert.equal(result.pageCount, 1);
  const image = result.visuals.find(v => v.objectType === 'embedded_image');
  assert.equal(image?.altText, 'Alt map');
  assert.equal(image?.sourceHyperlink, 'https://example.test/source');
  assert.equal(extractVisualBytes(new ArrayBuffer(0), entries, image!.locator)?.length, makeGray9x8Png().length);
  assert.ok(result.visuals.some(v => v.objectType === 'grouped_shapes' && !v.exactOriginalAvailable));
});

test('DOCX inspection associates image, caption, heading and hyperlink', () => {
  const doc = `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r" xmlns:wp="wp"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Risk maps</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:docPr id="1" name="Figure" descr="Hazard map"/><a:blip r:embed="rId1"/></w:drawing></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1. Hazard zones</w:t></w:r></w:p></w:body></w:document>`;
  const rels = `<Relationships><Relationship Id="rId1" Type="image" Target="media/image1.png"/><Relationship Id="rId2" Type="hyperlink" Target="https://example.test" TargetMode="External"/></Relationships>`;
  const entries = safeUnzipOoxml(packageZip({'[Content_Types].xml':'<Types/>','word/document.xml':doc,'word/_rels/document.xml.rels':rels,'word/media/image1.png':makeGray9x8Png(),'docProps/app.xml':'<Properties><Pages>2</Pages></Properties>'}));
  const result = inspectDocx(entries);
  assert.equal(result.pageCount, 2);
  assert.equal(result.visuals[0].nearbyHeading, 'Risk maps');
  assert.equal(result.visuals[0].caption, 'Figure 1. Hazard zones');
  assert.deepEqual(result.hyperlinks, ['https://example.test']);
});

test('PDF inventory preserves requested pages and extracts exact DCT stream', () => {
  const jpeg = String.fromCharCode(0xff,0xd8,1,2,3,0xff,0xd9);
  const pdf = `%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n4 0 obj << /Subtype /Image /Width 10 /Height 20 /Filter /DCTDecode /Length 7 >>\nstream\n${jpeg}\nendstream\nendobj\n/Title (Fixture) /Author (Tester)\n%%EOF`;
  const bytes = Uint8Array.from(pdf, character => character.charCodeAt(0) & 0xff);
  const result = inspectPdfBytes(ab(bytes));
  assert.equal(result.pageCount, 2);
  assert.equal(result.visuals.filter(v=>v.objectType==='pdf_page').length,2);
  const image=result.visuals.find(v=>v.objectType==='embedded_raster')!;
  const extracted=extractVisualBytes(ab(bytes),null,image.locator)!;
  assert.equal(extracted[0],0xff); assert.equal(extracted[1],0xd8);
});

test('CSV round-trip and work-name normalization are deterministic', () => {
  const csv=toCsv([{id:'1',path:'A, B',note:'line\n2'}],['id','path','note']);
  assert.deepEqual(parseCsv(csv),[['id','path','note'],['1','A, B','line\n2']]);
  assert.equal(baseNameForWork('Law_FINAL_copy.pdf'),'law');
});

test('documented dHash detects equal and opposite gradients', () => {
  const left=pngDifferenceHash(makeGray9x8Png(false));
  const same=pngDifferenceHash(makeGray9x8Png(false));
  const opposite=pngDifferenceHash(makeGray9x8Png(true));
  assert.equal(hammingDistanceHex(left,same),0);
  assert.equal(hammingDistanceHex(left,opposite),64);
});
