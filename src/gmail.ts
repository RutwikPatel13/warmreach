import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose", // create + send drafts
  "https://www.googleapis.com/auth/gmail.readonly", // read threads (Follow-ups reply detection)
];
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
  cc?: string;
  bcc?: string;
  attachmentPath?: string;
  // Reply on an existing thread (e.g. a follow-up) instead of starting a new
  // one: threadId ties the draft to it, In-Reply-To/References are the
  // standard headers mail clients use to render the reply inline.
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

// RFC 2047 encode header values that contain non-ASCII (e.g. em-dashes),
// so subjects render correctly in every mail client.
function encodeHeader(value: string): string {
  if (/[^\x00-\x7F]/.test(value)) {
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
  }
  return value;
}

const rand = () => Date.now() + "_" + Math.random().toString(36).slice(2);

// The body carries lightweight markdown — only **bold**, the one thing outreach
// emails use. Render it to HTML: escape first (so a stray "<" or "&" can't break
// the markup), then bold, then linkify bare URLs, then line breaks.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripBold(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1"); // for the plain-text part + the subject
}
function bodyToHtml(body: string): string {
  let s = escapeHtml(body)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, "<br>\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#202124">${s}</div>`;
}

function buildRaw(from: string, args: DraftArgs): string {
  const plain = stripBold(args.body); // plain-text alternative reads clean (no "**")
  const html = bodyToHtml(args.body);
  const alt = "alt_" + rand();

  // Body is always a plain+HTML alternative; a resume PDF, when present, wraps it
  // in a multipart/mixed. Non-HTML clients fall back to the plain-text part.
  const altBlock = [
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    plain,
    "",
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    "",
    `--${alt}--`,
    "",
  ];

  const headers = [
    `From: ${from}`,
    `To: ${args.to}`,
    // Only the compose dock sets these; every other caller omits them, so the
    // headers vanish and the message is byte-identical to before.
    ...(args.cc ? [`Cc: ${args.cc}`] : []),
    ...(args.bcc ? [`Bcc: ${args.bcc}`] : []),
    `Subject: ${encodeHeader(stripBold(args.subject))}`, // subjects can't be bold
    ...(args.inReplyTo ? [`In-Reply-To: ${args.inReplyTo}`] : []),
    ...(args.references ? [`References: ${args.references}`] : []),
    "MIME-Version: 1.0",
  ];

  let parts: string[];
  if (args.attachmentPath && fs.existsSync(args.attachmentPath)) {
    const mix = "mix_" + rand();
    const name = path.basename(args.attachmentPath);
    const data = fs.readFileSync(args.attachmentPath).toString("base64");
    parts = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mix}"`,
      "",
      `--${mix}`,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      ...altBlock,
      `--${mix}`,
      `Content-Type: application/pdf; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      data,
      "",
      `--${mix}--`,
      "",
    ];
  } else {
    parts = [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, "", ...altBlock];
  }

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
    requestBody: { message: { raw, threadId: args.threadId } },
  });
  return res.data.id ?? "(unknown id)";
}

// Updates an existing draft IN PLACE — replaces its content but keeps the same
// draft id (so a scheduled send tied to it stays valid) and never leaves a
// duplicate behind. Used when a re-draft edits an earlier draft. The
// gmail.compose scope covers this; no re-auth needed. Throws if the draft no
// longer exists (already sent/deleted) — the caller falls back to createDraft.
export async function updateDraft(auth: any, draftId: string, args: DraftArgs, from?: string): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  const fromAddr = from ?? (await getFromAddress(auth));
  const raw = buildRaw(fromAddr, args);
  const res = await gmail.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: { message: { raw } },
  });
  return res.data.id ?? draftId;
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

// Deletes a draft (used to undo a scheduled follow-up before it sends).
export async function deleteDraft(auth: any, draftId: string): Promise<void> {
  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.drafts.delete({ userId: "me", id: draftId });
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
