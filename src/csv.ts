// ── CSV parsing ─────────────────────────────────────────────────────────────
// Minimal RFC-4180-ish parser: handles quoted fields, embedded commas, escaped
// "" quotes, and CRLF/LF newlines. Returns rows of string cells.
//
// prospects.ts and contacts.ts each carry their own private copy of this. They
// work, and this module exists for prepSources.ts rather than as a refactor of
// them — the LeetCode mirrors ship a `Topics` column that is a quoted field
// full of commas, so a naive split() would shred it.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a CSV that has a header row into objects keyed by column name.
 * Header cells are trimmed but keep their original case — callers match on the
 * exact spellings the mirrors use ("Acceptance %", "Frequency %", …).
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = (r[i] ?? "").trim()));
    return rec;
  });
}
