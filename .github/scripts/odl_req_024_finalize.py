from pathlib import Path

path = Path("src/visual-classifier-capability-go-diagnostic.ts")
text = path.read_text()
old = '''  if (!payload.input?.__odlReq024GoVisionDiagnostic) throw new Error("ODL-REQ-024 diagnostic payload is invalid.");
  const jobId = String(payload.jobId ?? payload.workflowId ?? crypto.randomUUID()).slice(0, 100);'''
new = '''  if (!payload.input?.__odlReq024GoVisionDiagnostic) throw new Error("ODL-REQ-024 diagnostic payload is invalid.");
  await step.do("ODL-REQ-024 initialize sanitized diagnostic", async () => ({
    initialized: true,
    probeVersion: ODL_REQ_024_GO_PROBE_VERSION,
    oneDriveAccessed: false,
    sourcePdfRead: false,
  }));
  const jobId = String(payload.jobId ?? payload.workflowId ?? crypto.randomUUID()).slice(0, 100);'''
if old not in text:
    if "ODL-REQ-024 initialize sanitized diagnostic" in text:
        raise SystemExit(0)
    raise SystemExit("diagnostic initialization insertion point not found")
path.write_text(text.replace(old, new, 1))
