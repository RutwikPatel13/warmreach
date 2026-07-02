import { NextResponse } from "next/server";
import { loadStore, savePreset, saveTemplate, deleteItem } from "@/src/templateStore";
import { rejectNonLocal } from "@/src/localGuard";
import type { Variant, Email } from "@/src/personalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SaveRequest {
  kind?: "preset" | "template";
  name?: string;
  instructions?: string;
  variants?: Record<Variant, Email>;
}

export async function GET() {
  return NextResponse.json(loadStore());
}

// Saves a preset or template; an existing name is overwritten. Returns the
// updated store so the client can refresh its library in one round trip.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { kind, name, instructions, variants } = (await req
    .json()
    .catch(() => ({}))) as SaveRequest;

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  if (kind === "preset") {
    if (!instructions?.trim()) {
      return NextResponse.json({ error: "instructions are required for a preset." }, { status: 400 });
    }
    return NextResponse.json(savePreset(name, instructions.trim()));
  }

  if (kind === "template") {
    if (!variants?.recruiter?.subject || !variants?.recruiter?.body || !variants?.engineering?.subject || !variants?.engineering?.body) {
      return NextResponse.json(
        { error: "Both variants (subject + body) are required for a template." },
        { status: 400 },
      );
    }
    return NextResponse.json(saveTemplate(name, variants));
  }

  return NextResponse.json({ error: 'kind must be "preset" or "template".' }, { status: 400 });
}

export async function DELETE(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { kind, id } = (await req.json().catch(() => ({}))) as { kind?: string; id?: string };
  if ((kind !== "preset" && kind !== "template") || !id) {
    return NextResponse.json({ error: "kind and id are required." }, { status: 400 });
  }
  return NextResponse.json(deleteItem(kind, id));
}
