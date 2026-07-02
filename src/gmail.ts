import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";

const SCOPES = ["https://www.googleapis.com/auth/gmail.compose"];
const CRED_PATH = path.resolve("credentials/credentials.json");
const TOKEN_PATH = path.resolve("credentials/token.json");

export function gmailConfigured(): boolean {
  return fs.existsSync(CRED_PATH) || fs.existsSync(TOKEN_PATH);
}

// True only when an authorized token already exists — i.e. getGmailAuth() can
// return a client WITHOUT opening a browser. The web routes require this
// (the interactive OAuth flow must be run once via `npm run gmail:auth`).
export function hasGmailToken(): boolean {
  return fs.existsSync(TOKEN_PATH);
}

// Returns an authorized client, or null if credentials.json hasn't been set up.
// Reuses an existing token.json without opening a browser (required by the web
// routes). To refresh an expired/revoked token, use authorizeInteractive().
export async function getGmailAuth(): Promise<any | null> {
  if (fs.existsSync(TOKEN_PATH)) {
    const creds = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    return google.auth.fromJSON(creds);
  }
  return authorizeInteractive();
}

// Always runs the interactive browser OAuth flow (ignoring any existing token)
// and overwrites token.json. This is how an expired/revoked token is refreshed:
// getGmailAuth() short-circuits on an existing token.json and so can't recover
// from `invalid_grant` on its own. Used by `npm run gmail:auth`.
export async function authorizeInteractive(): Promise<any | null> {
  if (!fs.existsSync(CRED_PATH)) return null;

  const client = await authenticate({ scopes: SCOPES, keyfilePath: CRED_PATH });
  if (client.credentials?.refresh_token) {
    const keys = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));
    const key = keys.installed || keys.web;
    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify({
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      }),
    );
  }
  return client;
}

interface DraftArgs {
  to: string;
  subject: string;
  body: string;
  attachmentPath?: string;
}

// RFC 2047 encode header values that contain non-ASCII (e.g. em-dashes),
// so subjects render correctly in every mail client.
function encodeHeader(value: string): string {
  if (/[^\x00-\x7F]/.test(value)) {
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
  }
  return value;
}

function buildRaw(from: string, args: DraftArgs): string {
  const boundary = "rb_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  const parts: string[] = [
    `From: ${from}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(args.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    args.body,
    "",
  ];

  if (args.attachmentPath && fs.existsSync(args.attachmentPath)) {
    const name = path.basename(args.attachmentPath);
    const data = fs.readFileSync(args.attachmentPath).toString("base64");
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      data,
      "",
    );
  }

  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

// The authorized account's email address — fetch ONCE per batch and reuse as
// the `From`, rather than calling getProfile for every single draft.
export async function getFromAddress(auth: any): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  const me = await gmail.users.getProfile({ userId: "me" });
  return me.data.emailAddress ?? "me";
}

export async function createDraft(auth: any, args: DraftArgs, from?: string): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  const fromAddr = from ?? (await getFromAddress(auth));
  const raw = buildRaw(fromAddr, args);
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });
  return res.data.id ?? "(unknown id)";
}

// Sends an existing draft (the one createDraft made) — keeps its attachment and
// moves it to Sent. The gmail.compose scope authorizes this; no re-auth needed.
export async function sendDraft(auth: any, draftId: string): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.drafts.send({
    userId: "me",
    requestBody: { id: draftId },
  });
  return res.data.id ?? "(unknown id)";
}

// `npm run gmail:auth` -> pre-authorize once (opens a browser).
if (import.meta.url === `file://${process.argv[1]}`) {
  authorizeInteractive()
    .then((c) =>
      console.log(c ? "✅ Gmail authorized. token.json saved." : "⚠️  Drop credentials/credentials.json first."),
    )
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
