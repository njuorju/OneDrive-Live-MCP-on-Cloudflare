import fs from "node:fs";

function edit(path, changes) {
  let text = fs.readFileSync(path, "utf8");
  for (const [from, to] of changes) {
    if (!text.includes(from)) throw new Error(`${path}: expected patch anchor not found: ${from.slice(0, 100)}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

edit("src/auth-state.ts", [
  [
    '} from "./auth-store";\n',
    '} from "./auth-store";\nimport { processIntegrityCoordination, type CoordinationRequest } from "./integrity-coordination";\n',
  ],
  [
    '    if (url.pathname === "/ready") {\n',
    '    if (url.pathname === "/integrity-coordinate") {\n      return this.coordinateIntegrity(request);\n    }\n\n    if (url.pathname === "/ready") {\n',
  ],
  [
    '  private cleanupRenderCache(now = Date.now()): void {\n',
    '  private async coordinateIntegrity(request: Request): Promise<Response> {\n    let body: CoordinationRequest;\n    try {\n      body = await request.json() as CoordinationRequest;\n    } catch {\n      return Response.json({ ok: false, code: "coordination_invalid_json", message: "The integrity coordination request is invalid." }, { status: 400 });\n    }\n    try {\n      const result = await this.ctx.storage.transaction((transaction) => processIntegrityCoordination(transaction, body));\n      return Response.json({ ok: true, result });\n    } catch (error) {\n      const value = error as { code?: string; message?: string; retryable?: boolean };\n      return Response.json({ ok: false, code: value.code ?? "coordination_failed", message: value.message ?? "Integrity coordination failed.", retryable: Boolean(value.retryable) }, { status: value.retryable ? 503 : 409 });\n    }\n  }\n\n  private cleanupRenderCache(now = Date.now()): void {\n',
  ],
]);

edit("src/integrity-resume-repair.ts", [
  [
    'async function getIntegrityJobStatus(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<JobRecord> {',
    'export async function getIntegrityJobStatus(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<JobRecord> {',
  ],
]);

edit("src/index-hotfix.ts", [
  [
    'import {\n  continueSourceSnapshotJob,\n  registerSourceSnapshotRepairTools,\n} from "./source-snapshot-repair";\n',
    'import { registerSourceSnapshotRepairTools } from "./source-snapshot-repair";\n',
  ],
  [
    'import { registerBlockedMoveReconciliationTool } from "./integrity-blocked-move-reconcile";\n',
    'import { registerBlockedMoveReconciliationTool } from "./integrity-blocked-move-reconcile";\nimport { continueSnapshotWithLease, registerIntegrityLeaseTools } from "./integrity-lease-tools";\n',
  ],
  [
    '    await continueSourceSnapshotJob(\n      {\n        env: this.env,\n        userId,\n        storage: createIntegratedStateStorage(this.env, userId),\n      },\n      schedule,\n      jobId,\n    );\n',
    '    await continueSnapshotWithLease(\n      {\n        env: this.env,\n        userId,\n        storage: createIntegratedStateStorage(this.env, userId),\n      },\n      schedule,\n      jobId,\n    );\n',
  ],
  [
    '    registerBlockedMoveReconciliationTool(replacementServer, contextFactory);\n',
    '    registerBlockedMoveReconciliationTool(replacementServer, contextFactory);\n    registerIntegrityLeaseTools(replacementServer, contextFactory, schedule);\n',
  ],
]);

edit("worker-configuration.d.ts", [
  [
    '  IMAGE_PROCESSING_TIMEOUT_MS: string;\n',
    '  IMAGE_PROCESSING_TIMEOUT_MS: string;\n  INTEGRITY_LEASE_SECONDS?: string;\n  WORKER_DEPLOYMENT_ID?: string;\n  WORKER_VERSION?: string;\n',
  ],
]);

edit("wrangler.jsonc", [
  [
    '    "IMAGE_PROCESSING_TIMEOUT_MS": "15000"\n',
    '    "IMAGE_PROCESSING_TIMEOUT_MS": "15000",\n    "INTEGRITY_LEASE_SECONDS": "600"\n',
  ],
]);

edit(".github/workflows/upload-integrity-resume-candidate.yml", [
  [
    '    paths:\n      - .github/workflows/upload-integrity-resume-candidate.yml\n',
    '    paths:\n      - .github/workflows/upload-integrity-resume-candidate.yml\n      - src/auth-state.ts\n      - src/index-hotfix.ts\n      - src/integrity-coordination.ts\n      - src/integrity-lease-tools.ts\n      - src/integrity-resume-repair.ts\n      - test/integrity-coordination.test.ts\n      - worker-configuration.d.ts\n      - wrangler.jsonc\n',
  ],
  [
    '              "IMAGE_PROCESSING_TIMEOUT_MS": "15000"\n',
    '              "IMAGE_PROCESSING_TIMEOUT_MS": "15000",\n              "INTEGRITY_LEASE_SECONDS": "600",\n              "WORKER_DEPLOYMENT_ID": "repo-${{ github.event.pull_request.head.sha }}"\n',
  ],
]);

console.log("Integrity lease wiring applied.");
