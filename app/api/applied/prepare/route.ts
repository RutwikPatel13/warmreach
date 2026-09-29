import { NextResponse } from "next/server";
import { creditsFor, prepare } from "@/src/applied";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const POOL = 3; // applications prepared at once — Apollo search + a page fetch each
const MAX = 100;

// FREE — no Apollo credits and no Claude: reads each posting, finds the people
// and picks the best by title. Streams one NDJSON line per application.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { ids } = (await req.json().catch(() => ({}))) as { ids?: string[] };
  const queue = (ids ?? []).filter(Boolean).slice(0, MAX);
  if (!queue.length) return NextResponse.json({ error: "Pick at least one application." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      let next = 0;
      async function worker() {
        for (;;) {
          const id = queue[next++];
          if (!id) return;
          send({ id, status: "preparing" });
          try {
            const a = await prepare(id);
            const { picked, credits } = creditsFor(a);
            send({ id, status: a.status, error: a.error, role: a.role, company: a.org?.name ?? a.company, picked, credits });
          } catch (e: any) {
            send({ id, status: "stuck", error: e?.message ?? "Preparing failed." });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
      send({ done: true });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
