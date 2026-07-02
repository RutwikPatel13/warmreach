import { NextResponse } from "next/server";
import { listResumes } from "@/src/resume";
import { profile } from "@/src/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lists the PDFs the browser can pick from (it can't read the filesystem itself).
export async function GET() {
  return NextResponse.json({
    resumes: listResumes(),
    default: profile.resumePath,
    dir: profile.resumeDir,
  });
}
