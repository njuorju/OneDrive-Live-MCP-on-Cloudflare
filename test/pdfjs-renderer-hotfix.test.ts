import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfJsRenderHtml } from "../src/pdfjs-renderer-hotfix";

test("PDF.js renderer embeds one PDF and targets one requested page", () => {
  const html = buildPdfJsRenderHtml({
    pdfBase64: "JVBERi0xLjQ=",
    page: 3,
    width: 960,
    height: 540,
    mainSource: "window.pdfjsLib={getDocument(){}};",
    workerSource: "window.pdfjsWorker={WorkerMessageHandler:{}};",
  });

  assert.match(html, /const PDF_BASE64 = "JVBERi0xLjQ=";/);
  assert.match(html, /const PAGE = 3;/);
  assert.match(html, /const TARGET_WIDTH = 960;/);
  assert.match(html, /const TARGET_HEIGHT = 540;/);
  assert.match(html, /page-canvas/);
  assert.match(html, /dataset\.renderComplete = "true"/);
  assert.match(html, /window\.pdfjsLib/);
  assert.match(html, /window\.pdfjsWorker/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /__document-render/);
  assert.doesNotMatch(html, /#page=/);
});

test("PDF.js renderer forces same-thread fallback and fails closed on uniform output", () => {
  const html = buildPdfJsRenderHtml({
    pdfBase64: "JVBERi0xLjQ=",
    page: 1,
    width: 1600,
    height: 900,
    crop: { x: 10, y: 20, width: 300, height: 200 },
    mainSource: "window.pdfjsLib={getDocument(){}};",
    workerSource: "window.pdfjsWorker={WorkerMessageHandler:{}};",
  });

  assert.match(html, /Object\.defineProperty\(window,"Worker",\{value:undefined/);
  assert.match(html, /data: decodePdf\(\)/);
  assert.match(html, /blank_or_uniform_canvas/);
  assert.match(html, /"x":10/);
  assert.match(html, /"height":200/);
  assert.match(html, /render\(\)\.catch/);
  assert.doesNotMatch(
    html,
    /dataset\.renderComplete = "true"[\s\S]*catch[\s\S]*dataset\.renderComplete/,
  );
});

test("inline libraries cannot terminate their script element", () => {
  const html = buildPdfJsRenderHtml({
    pdfBase64: "JVBERi0xLjQ=",
    page: 1,
    width: 960,
    height: 540,
    mainSource: "window.main='</script>';",
    workerSource: "window.worker='</SCRIPT>';",
  });

  assert.doesNotMatch(html, /window\.(main|worker)='<\/script>'/i);
  assert.match(html, /window\.main='<\\\/script>';/i);
  assert.match(html, /window\.worker='<\\\/script>';/i);
});
