import { NextResponse } from "next/server";
import { generateVariants, type Variant, type Email } from "@/src/personalize";
import { loadStore } from "@/src/templateStore";
import { rejectNonLocal } from "@/src/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GenerateRequest {
  company?: { name?: string; description?: string | null; keywords?: string[] };
  role?: string;
  jobDescription?: string;
  promptInstructions?: string;
  templateId?: string;
}

// Two Claude calls (recruiter + engineering templates) for the whole company.
// No Apollo cost here — uses the company facts captured during search.
export async function POST(req: Request) {
  const forbidden = rejectNonLocal(req);
  if (forbidden) return forbidden;

  try {
    const { company, role, jobDescription, promptInstructions, templateId } =
      (await req.json()) as GenerateRequest;
    if (!company?.name || !role?.trim()) {
      return NextResponse.json({ error: "company and role are required." }, { status: 400 });
    }

    // When a saved template is selected, it becomes the BASE Claude adapts —
    // merge its {company}/{role} placeholders for this company first.
    let baseVariants: Record<Variant, Email> | undefined;
    if (templateId) {
      const saved = loadStore().templates.find((t) => t.id === templateId);
      if (!saved) {
        return NextResponse.json(
          { error: "Selected template no longer exists — pick another or use “create new”." },
          { status: 400 },
        );
      }
      const merge = (s: string) =>
        s.split("{company}").join(company.name!).split("{role}").join(role.trim());
      baseVariants = {
        recruiter: {
          subject: merge(saved.variants.recruiter.subject),
          body: merge(saved.variants.recruiter.body),
        },
        engineering: {
          subject: merge(saved.variants.engineering.subject),
          body: merge(saved.variants.engineering.body),
        },
      };
    }

    const variants = await generateVariants(
      {
        name: company.name,
        description: company.description ?? null,
        keywords: company.keywords ?? [],
      },
      role.trim(),
      jobDescription,
      promptInstructions,
      baseVariants,
    );

    return NextResponse.json({ variants });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Generation failed." }, { status: 500 });
  }
}
