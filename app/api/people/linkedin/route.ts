import { NextResponse } from "next/server";
import { enrichPersonByLinkedin } from "@/src/apollo";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PAID — spends 1 Apollo credit. Exact person lookup by LinkedIn profile URL, the
// opt-in fallback the /people URL box offers when the FREE name search finds no
// one (Apollo's free search can't match bare slugs like ".../in/deepshah08"). The
// client decrements the local credit meter on a successful (2xx) response, exactly
// like /people/reveal. Returns the person row + revealed contact in one shot.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { linkedinUrl } = (await req.json()) as { linkedinUrl?: string };
    if (!linkedinUrl?.trim()) {
      return NextResponse.json({ error: "A LinkedIn URL is required." }, { status: 400 });
    }

    const c = await enrichPersonByLinkedin(linkedinUrl.trim());
    return NextResponse.json({
      person: {
        id: c.linkedin ?? linkedinUrl.trim(),
        firstName: c.firstName,
        lastName: c.lastName ?? null,
        title: c.title,
        seniority: c.seniority ?? null,
        linkedin: c.linkedin ?? null,
        photo: null,
        location: null,
        hasEmail: !!c.email,
      },
      contact: {
        fullName: c.fullName,
        email: c.email,
        emailStatus: c.emailStatus,
        title: c.title,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Lookup failed." }, { status: 500 });
  }
}
