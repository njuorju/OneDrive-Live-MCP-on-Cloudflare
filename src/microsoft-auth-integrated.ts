import { MicrosoftAuthHandler } from "./microsoft-auth";

function htmlCapabilityText(html: string): string {
  return html
    .replace(
      "may be searched, read, visually analysed, retrieved, created, replaced, renamed, or moved.",
      "may be searched, read, inspected, rendered, copied, catalogued, created, replaced, renamed, moved, or—only through a validated integrity plan—recycled.",
    )
    .replace(
      "<li>No deletion or recycle-bin tools.</li>",
      "<li>No generic delete, permanent-delete, or recycle-bin-emptying tools. Recycling is available only for explicitly approved items in a validated, short-lived integrity plan.</li>",
    )
    .replace(
      "<li>No arbitrary binary upload or arbitrary Graph requests.</li>",
      "<li>No arbitrary binary upload or arbitrary Graph requests. Generated visual outputs use allowlisted, conflict-safe uploads inside the configured root.</li>",
    );
}

async function delegate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const handler = MicrosoftAuthHandler as unknown as { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };
  return await handler.fetch(request, env, ctx);
}

export const IntegratedMicrosoftAuthHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ready" && !env.BROWSER) {
      return Response.json({
        ready: false,
        error: {
          code: "binding_missing",
          message: "A required Worker binding is missing.",
          retryable: false,
          correlationId: crypto.randomUUID(),
        },
      }, { status: 503 });
    }

    const response = await delegate(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/authorize" && response.headers.get("content-type")?.includes("text/html")) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(htmlCapabilityText(await response.text()), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (request.method === "GET" && url.pathname === "/" && response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json() as Record<string, unknown>;
      return Response.json({
        ...body,
        genericDeletion: false,
        planGatedRecycle: true,
        permanentDeletion: false,
        sharing: false,
        snapshots: true,
        documentVisuals: true,
        integrityPlans: true,
      }, { status: response.status, headers: response.headers });
    }

    if (request.method === "GET" && url.pathname === "/ready" && response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json() as Record<string, unknown>;
      return Response.json({ ...body, browserRun: true, integratedTools: true }, { status: response.status, headers: response.headers });
    }

    return response;
  },
};
