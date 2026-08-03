import { NextResponse } from "next/server";
import { enrichPerson } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reveal ONE person's verified email. This is the single credit-spending action
// in the intelligence layer — Apollo charges 1 credit per matched person. The
// client decrements the local credit meter on a successful (2xx) response.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { id, domain } = (await req.json()) as { id?: string; domain?: string };
    if (!id) return NextResponse.json({ error: "A person id is required." }, { status: 400 });

    const contact = await enrichPerson(id, domain);
    return NextResponse.json({
      contact: {
        fullName: contact.fullName,
        firstName: contact.firstName,
        lastName: contact.lastName,
        title: contact.title,
        email: contact.email,
        emailStatus: contact.emailStatus,
        seniority: contact.seniority,
        linkedin: contact.linkedin,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Reveal failed." }, { status: 500 });
  }
}
