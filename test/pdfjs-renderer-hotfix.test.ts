import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfJsRenderHtml } from "../src/pdfjs-renderer-hotfix";

test("PDF.js renderer targets one requested page and exposes a completion sentinel", () => {
  const html = buildPdfJsRenderHtml({
    token: "sealed-token",
    page: 3,
    width: 960,
    height: 540,
  });

  assert.match(html, /const PAGE = 3;/);
  assert.match(html, /const TARGET_WIDTH = 960;/);
  assert.match(html, /const TARGET_HEIGHT = 540;/);
  assert.match(html, /page-canvas/);
  assert.match(html, /dataset\.renderComplete = "true"/);
  assert.match(html, /__document-render\/sealed-token/);
  assert.doesNotMatch(html, /#page=/);
  assert.doesNotMatch(html, /zoom=page-fit/);
});

test("PDF.js renderer forces same-thread fallback and fails closed on uniform output", () => {
  const html = buildPdfJsRenderHtml({
    token: "sealed-token",
    page: 1,
    width: 1600,
    height: 900,
    crop: { x: 10, y: 20, width: 300, height: 200 },
  });

  assert.match(html, /Object\.defineProperty\(window,"Worker",\{value:undefined/);
  assert.match(html, /pdf\.worker\.min\.js/);
  assert.match(html, /blank_or_uniform_canvas/);
  assert.match(html, /"x":10/);
  assert.match(html, /"height":200/);
  assert.match(html, /render\(\)\.catch/);
  assert.doesNotMatch(html, /dataset\.renderComplete = "true"[\s\S]*catch[\s\S]*dataset\.renderComplete/);
});
