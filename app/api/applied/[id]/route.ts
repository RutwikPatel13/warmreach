import { NextResponse } from "next/server";
import path from "node:path";
import { getApplication, historyOf, resumeFileOf, stageOf, updateApplication } from "@/src/applied";
import type { Email, Variant } from "@/src/personalize";
import { queuedIds, resume } from "@/src/appliedRun";
import { rejectNonLocal } from "@/src/localGuard";
import { profile } from "@/src/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// One application in full, for the board's details drawer and the review queue.
export async function GET(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  const a = getApplication(id);
  if (!a) return NextResponse.json({ error: "No application with that id." }, { status: 404 });
  const file = resumeFileOf(a);
  const { stage, detail } = stageOf(a, { queued: queuedIds(), drafts: a.boardDrafts?.length ?? 0, sent: (a.boardDrafts ?? []).some((d) => d.sentAt), replied: false });
  return NextResponse.json({
    application: a,
    stage,
    detail,
    history: historyOf(a),
    resume: {
      saved: !!file,
      name: path.basename(file ?? profile.resumePath),
      fromTsenta: !!file,
      baseName: path.basename(profile.resumePath),
    },
  });
}

// Fix or adjust one application:
// - companyWebsite / jd: what a stuck run was missing. A started row then
//   carries on from where it stopped (free until the emails are written).
// - picked: which people to email.
// - resumeFallback: "base" sends your base résumé instead of waiting for Tsenta's.
// - emails: edited templates, kept for the review queue.
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;
  const { id } = await params;
  const cur = getApplication(id);
  if (!cur) return NextResponse.json({ error: "No application with that id." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    jd?: string;
    companyWebsite?: string;
    picked?: string[];
    resumeFallback?: "wait" | "base";
    emails?: Record<Variant, Email>;
  };
  let unstuck = false;
  const app = updateApplication(id, (a) => {
    if (typeof body.jd === "string" && body.jd.trim()) {
      a.jd = body.jd.trim();
      a.jdSource = "pasted";
      unstuck = true;
    }
    if (typeof body.companyWebsite === "string" && body.companyWebsite.trim()) {
      a.companyWebsite = body.companyWebsite.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      unstuck = true;
    }
    if (unstuck && a.status === "stuck") { a.status = "new"; a.error = null; a.stuckReason = null; }
    if (Array.isArray(body.picked)) {
      const want = new Set(body.picked);
      for (const p of a.people) p.picked = want.has(p.id);
    }
    if (body.resumeFallback === "base" || body.resumeFallback === "wait") {
      a.options = { ...(a.options ?? { templateId: null, presetId: null, pick: 3, roles: { recruiter: true, team: true, founders: true } }), resumeFallback: body.resumeFallback };
    }
    if (body.emails?.recruiter?.body && body.emails?.engineering?.body) a.emails = body.emails;
  });
  const continued = unstuck && app.startedAt ? resume(id) > 0 : false;
  return NextResponse.json({ status: app.status, continued });
}
