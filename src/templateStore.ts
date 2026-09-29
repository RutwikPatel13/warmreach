import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Variant, Email } from "./personalize";

// File-backed library of reusable generation inputs/outputs (web app):
// - prompt presets: named instruction sets that steer Claude generation
// - saved templates: literal edited subject+body pairs, reusable with
//   {company}/{role} placeholders and zero Claude cost
// Lives in data/ (git-ignored) next to the outreach log.

const FILE = path.resolve("data/templates.json");

export interface PromptPreset {
  id: string;
  name: string;
  instructions: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SavedTemplate {
  id: string;
  name: string;
  variants: Record<Variant, Email>;
  createdAt: string;
  updatedAt?: string;
  // "Same email for both audiences": the Templates editor writes one email to
  // both variants. Generation is unaffected — both variants are always stored.
  linked?: boolean;
}

export interface TemplateStore {
  presets: PromptPreset[];
  templates: SavedTemplate[];
}

export function loadStore(): TemplateStore {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { presets: raw.presets ?? [], templates: raw.templates ?? [] };
  } catch {
    return { presets: [], templates: [] }; // missing or corrupt file = empty library
  }
}

function writeStore(store: TemplateStore): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Saving under an existing name overwrites that entry (keeps its id).
export function savePreset(name: string, instructions: string): TemplateStore {
  const store = loadStore();
  const existing = store.presets.find((p) => sameName(p.name, name));
  if (existing) {
    existing.instructions = instructions;
    existing.updatedAt = new Date().toISOString();
  } else {
    store.presets.push({
      id: crypto.randomUUID(),
      name: name.trim(),
      instructions,
      createdAt: new Date().toISOString(),
    });
  }
  writeStore(store);
  return store;
}

export function saveTemplate(name: string, variants: Record<Variant, Email>): TemplateStore {
  const store = loadStore();
  const existing = store.templates.find((t) => sameName(t.name, name));
  if (existing) {
    existing.variants = variants;
    existing.updatedAt = new Date().toISOString();
  } else {
    store.templates.push({
      id: crypto.randomUUID(),
      name: name.trim(),
      variants,
      createdAt: new Date().toISOString(),
    });
  }
  writeStore(store);
  return store;
}

export class TemplateStoreError extends Error {}

// Edits by id (the Templates page), so a rename can't silently merge into a
// different entry the way a save-by-name would. Renaming onto a name another
// entry already uses is refused rather than overwriting it.
function assertNameFree(items: { id: string; name: string }[], id: string, name: string) {
  if (items.some((x) => x.id !== id && sameName(x.name, name))) {
    throw new TemplateStoreError(`Another entry is already called “${name.trim()}”.`);
  }
}

export function updatePreset(id: string, patch: { name?: string; instructions?: string }): TemplateStore {
  const store = loadStore();
  const preset = store.presets.find((p) => p.id === id);
  if (!preset) throw new TemplateStoreError("That preset no longer exists.");
  if (patch.name !== undefined) {
    assertNameFree(store.presets, id, patch.name);
    preset.name = patch.name.trim();
  }
  if (patch.instructions !== undefined) preset.instructions = patch.instructions;
  preset.updatedAt = new Date().toISOString();
  writeStore(store);
  return store;
}

export function updateTemplate(
  id: string,
  patch: { name?: string; variants?: Record<Variant, Email>; linked?: boolean },
): TemplateStore {
  const store = loadStore();
  const tpl = store.templates.find((t) => t.id === id);
  if (!tpl) throw new TemplateStoreError("That template no longer exists.");
  if (patch.name !== undefined) {
    assertNameFree(store.templates, id, patch.name);
    tpl.name = patch.name.trim();
  }
  if (patch.variants) tpl.variants = patch.variants;
  if (patch.linked !== undefined) tpl.linked = patch.linked;
  tpl.updatedAt = new Date().toISOString();
  writeStore(store);
  return store;
}

export function deleteItem(kind: "preset" | "template", id: string): TemplateStore {
  const store = loadStore();
  if (kind === "preset") store.presets = store.presets.filter((p) => p.id !== id);
  else store.templates = store.templates.filter((t) => t.id !== id);
  writeStore(store);
  return store;
}
