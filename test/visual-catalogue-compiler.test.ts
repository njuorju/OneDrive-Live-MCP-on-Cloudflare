import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReviewOverrides,
  applySeries,
  assertMasterParity,
  detectVisualSeries,
  enforceFalseRejectProtection,
  masterJsonFromCsv,
  renderCacheIdentity,
  reviewFingerprint,
  type ClassificationProposal,
  type SourceIdentity,
  type VisualResultRecord,
} from "../src/visual-catalogue-model";

const source: SourceIdentity = {
  itemId: "item-1",
  path: "Visual/source.pdf",
  filename: "source.pdf",
  eTag: "etag-1",
  byteSize: 123,
  sha256: "a".repeat(64),
};

function record(page: number, description: string, visualType = "map"): VisualResultRecord {
  return {
    version: 1,
    jobId: "00000000-0000-4000-8000-000000000001",
    source,
    stableVisualId: `vis_${String(page).padStart(48, "0")}`,
    stableKey: `pdf:page:${page}`,
    pageOrSlide: page,
    parentPages: [page],
    relationship: "page",
    renderArtifactId: `render_${String(page).padStart(48, "0")}`,
    embeddedArtifactId: null,
    artifactSha256: String(page).padStart(64, "0"),
    artifactWidth: 1600,
    artifactHeight: 900,
    artifactFormat: "png",
    artifactR2Key: `cache/${page}.png`,
    sourceType: "spatial_plan",
    routingMode: "page_compositions",
    outcome: "retain_canonical",
    confidence: 0.95,
    conciseDescription: description,
    retainRationale: "Reusable planning composition.",
    rejectRationale: null,
    visualType,
    pageSeriesId: null,
    canonicalVisualId: null,
    reviewState: "unreviewed",
    deterministicOutcome: null,
    modelOutcome: "retain_canonical",
    disagreement: false,
    modelProvider: "openai",
    model: "gpt-5.2-2025-12-11",
    pinnedModelVersion: "gpt-5.2-2025-12-11",
    rubricVersion: "rubric-1",
    promptVersion: "prompt-1",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    error: null,
  };
}

test("render cache identity is deterministic and parameter-sensitive", async () => {
  const descriptor = {
    sourceSha256: "a".repeat(64),
    stableKey: "pdf:page:18",
    outputFormat: "png" as const,
    width: 1600,
    dpi: 144,
    crop: null,
    rendererVersion: "pdfjs-cache-v1",
  };
  const first = await renderCacheIdentity(descriptor);
  const second = await renderCacheIdentity({ ...descriptor });
  const changed = await renderCacheIdentity({ ...descriptor, width: 1800 });
  assert.deepEqual(first, second);
  assert.notEqual(first.renderArtifactId, changed.renderArtifactId);
  assert.match(first.r2Key, /^visual-cache\/a{64}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
});

test("known retained candidates cannot be automatically rejected", () => {
  const proposal: ClassificationProposal = {
    outcome: "reject",
    confidence: 0.98,
    visualType: "map",
    conciseDescription: "Candidate map.",
    retainRationale: null,
    rejectRationale: "Model rejected it.",
    reusableVisualStructure: true,
    continuationLikely: false,
    continuationTitle: null,
    deterministicOutcome: null,
    deterministicReason: null,
    modelOutcome: "reject",
    modelReason: null,
    disagreement: false,
    secondPassApplied: false,
  };
  const protectedProposal = enforceFalseRejectProtection(proposal, true);
  assert.equal(protectedProposal.outcome, "needs_review");
  assert.equal(protectedProposal.disagreement, true);
  assert.ok(protectedProposal.confidence <= 0.74);
});

test("adjacent continuation maps become one auditable series", async () => {
  const records = [
    record(26, "Strategic hazard mitigation map showing western interventions."),
    record(27, "Continuation of the strategic hazard mitigation map showing eastern interventions."),
    record(30, "Resource conservation strategy map."),
  ];
  const series = await detectVisualSeries(records);
  assert.equal(series.length, 1);
  assert.deepEqual(series[0].memberStableKeys, ["pdf:page:26", "pdf:page:27"]);
  const applied = applySeries(records, series);
  assert.equal(applied.filter((item) => item.outcome === "retain_series_member").length, 1);
  assert.equal(applied[0].pageSeriesId, series[0].seriesId);
  assert.equal(applied[1].canonicalVisualId, series[0].canonicalVisualId);
});

test("review fingerprint changes when a decision changes", async () => {
  const base = [record(5, "Project framework diagram.")];
  const first = await reviewFingerprint({
    jobId: base[0].jobId,
    resultFingerprints: base.map((item) => ({ stableVisualId: item.stableVisualId, outcome: item.outcome, confidence: item.confidence, pageSeriesId: item.pageSeriesId, canonicalVisualId: item.canonicalVisualId })),
    series: [],
  });
  const overridden = applyReviewOverrides(base, [{ stableVisualId: base[0].stableVisualId, outcome: "needs_review" }]);
  const second = await reviewFingerprint({
    jobId: base[0].jobId,
    resultFingerprints: overridden.map((item) => ({ stableVisualId: item.stableVisualId, outcome: item.outcome, confidence: item.confidence, pageSeriesId: item.pageSeriesId, canonicalVisualId: item.canonicalVisualId })),
    series: [],
    overrides: [{ stableVisualId: base[0].stableVisualId, outcome: "needs_review" }],
  });
  assert.notEqual(first, second);
});

test("master CSV and object-record JSON remain exactly aligned", () => {
  const csv = "visual_id,stable_visual_key,description\nvis_1,pdf:page:1,Map\nvis_2,pdf:page:2,Diagram\n";
  const currentJson = JSON.stringify({ schema: ["visual_id", "stable_visual_key", "description"], records: [] });
  const json = masterJsonFromCsv(csv, currentJson);
  const parity = assertMasterParity(csv, json);
  assert.equal(parity.recordCount, 2);
  assert.equal(parity.parity, true);
});
