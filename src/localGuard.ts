import { NextResponse } from "next/server";

// This app runs with real Gmail/Apollo credentials but no auth of its own, so
// state-changing routes must reject requests that didn't come from the local
// UI. Otherwise any webpage you happen to visit could fire a cross-site POST
// at localhost:3000 and send mail / spend Apollo credits (drive-by CSRF).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostIsLocal(host: string | null): boolean {
  if (!host) return false;
  try {
    // Host header carries no scheme; URL needs one to parse "host:port".
    return LOCAL_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function originIsLocal(origin: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false; // includes the literal "null" origin (sandboxed iframes etc.)
  }
}

// Returns a 403 response for non-local requests, or null when the request is
// fine. Browsers attach an Origin header to every cross-site POST (including
// "simple" no-preflight ones), so checking it when present blocks the drive-by
// vector; requests without an Origin (curl, server-side) are not that vector.
export function rejectNonLocal(req: Request): NextResponse | null {
  if (!hostIsLocal(req.headers.get("host"))) {
    return NextResponse.json({ error: "Forbidden: local requests only." }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin !== null && !originIsLocal(origin)) {
    return NextResponse.json({ error: "Forbidden: cross-origin request rejected." }, { status: 403 });
  }
  return null;
}
