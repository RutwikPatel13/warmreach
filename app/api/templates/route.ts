import { NextResponse } from "next/server";
import {
  loadStore,
  savePreset,
  saveTemplate,
  deleteItem,
  updatePreset,
  updateTemplate,
  TemplateStoreError,
} from "@/src/templateStore";
import { rejectNonLocal } from "@/src/localGuard";
import type { Variant, Email } from "@/src/personalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SaveRequest {
  kind?: "preset" | "template";
  name?: string;
  instructions?: string;
  variants?: Record<Variant, Email>;
  // The Templates page creates with this set: a name already in use is refused
  // instead of overwritten (Compose's "Save as template" keeps overwrite-by-name).
  createOnly?: boolean;
}

interface PatchRequest {
  kind?: "preset" | "template";
  id?: string;
  name?: string;
  instructions?: string;
  variants?: Record<Variant, Email>;
  linked?: boolean;
}

const completeVariants = (v?: Record<Variant, Email>) =>
  Boolean(v?.recruiter?.subject?.trim() && v?.recruiter?.body?.trim() && v?.engineering?.subject?.trim() && v?.engineering?.body?.trim());

const nameTaken = (items: { name: string }[], name: string) =>
  items.some((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());

export async function GET() {
  return NextResponse.json(loadStore());
}

// Saves a preset or template; an existing name is overwritten. Returns the
// updated store so the client can refresh its library in one round trip.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { kind, name, instructions, variants, createOnly } = (await req
    .json()
    .catch(() => ({}))) as SaveRequest;

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  if (createOnly) {
    const store = loadStore();
    if (nameTaken(kind === "preset" ? store.presets : store.templates, name)) {
      return NextResponse.json({ error: `Another entry is already called “${name.trim()}”.` }, { status: 409 });
    }
  }

  if (kind === "preset") {
    if (!instructions?.trim()) {
      return NextResponse.json({ error: "instructions are required for a preset." }, { status: 400 });
    }
    return NextResponse.json(savePreset(name, instructions.trim()));
  }

  if (kind === "template") {
    if (!completeVariants(variants)) {
      return NextResponse.json(
        { error: "Both variants (subject + body) are required for a template." },
        { status: 400 },
      );
    }
    return NextResponse.json(saveTemplate(name, variants!));
  }

  return NextResponse.json({ error: 'kind must be "preset" or "template".' }, { status: 400 });
}

// Edits one entry by id: rename, new text, or the template's "same email for
// both" flag. Returns the updated store, like POST.
export async function PATCH(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  const { kind, id, name, instructions, variants, linked } = (await req
    .json()
    .catch(() => ({}))) as PatchRequest;
  if ((kind !== "preset" && kind !== "template") || !id) {
    return NextResponse.json({ error: "kind and id are required." }, { status: 400 });
  }
  if (name !== undefined && !name.trim()) {
    return NextResponse.json({ error: "name can't be empty." }, { status: 400 });
  }

  try {
    if (kind === "preset") {
      if (instructions !== undefined && !instructions.trim()) {
        return NextResponse.json({ error: "instructions can't be empty." }, { status: 400 });
      }
      return NextResponse.json(updatePreset(id, { name, instructions: instructions?.trim() }));
    }
    if (variants !== undefined && !completeVariants(variants)) {
      return NextResponse.json(
        { error: "Both variants (subject + body) are required for a template." },
        { status: 400 },
      );
    }
    return NextResponse.json(updateTemplate(id, { name, variants, linked }));
  } catch (e) {
    if (e instanceof TemplateStoreError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
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
