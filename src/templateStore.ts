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
}

export interface SavedTemplate {
  id: string;
  name: string;
  variants: Record<Variant, Email>;
  createdAt: string;
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

export function deleteItem(kind: "preset" | "template", id: string): TemplateStore {
  const store = loadStore();
  if (kind === "preset") store.presets = store.presets.filter((p) => p.id !== id);
  else store.templates = store.templates.filter((t) => t.id !== id);
  writeStore(store);
  return store;
}
