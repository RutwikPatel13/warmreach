"use client";

// A LaTeX editor that behaves like the one in Overleaf: line numbers, syntax
// colour, and problem markers on the lines TeX complained about.
//
// It's a transparent <textarea> over a highlighted <pre>. CodeBlock.tsx warns
// that this trick drifts when lines wrap — which is true when the two layers
// disagree about ANY metric, and résumé bullets are 200+ characters so wrapping
// is not optional. The fix is to stop trusting that the two layers happen to
// match: both get the exact same class, and every property that affects layout
// is declared once in .rs-code (see globals.css). Nothing here sets padding,
// font or wrapping on one layer alone.

import { useEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import latex from "highlight.js/lib/languages/latex";

let registered = false;
function register(): void {
  if (registered) return;
  hljs.registerLanguage("latex", latex);
  registered = true;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface LineMark {
  line: number;
  kind: "error" | "overfull" | "changed";
  title: string;
}

export default function TexEditor({
  value,
  onChange,
  marks = [],
  scrollToLine,
}: {
  value: string;
  onChange: (next: string) => void;
  marks?: LineMark[];
  /**
   * Jump the editor to a line (e.g. clicking a row in the fit report). Carries
   * a nonce because clicking the same row twice must scroll twice — a bare
   * line number is an unchanged dependency the second time.
   */
  scrollToLine?: { line: number; n: number } | null;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    register();
    try {
      return hljs.highlight(value, { language: "latex", ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(value);
    }
  }, [value]);

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const markByLine = useMemo(() => {
    const m = new Map<number, LineMark>();
    // An error outranks a warning on the same line — show the one that blocks.
    for (const mark of marks) {
      const existing = m.get(mark.line);
      if (!existing || (existing.kind !== "error" && mark.kind === "error")) m.set(mark.line, mark);
    }
    return m;
  }, [marks]);

  // Keep the highlight layer and the gutter locked to the textarea's scroll.
  function syncScroll(): void {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }

  useEffect(() => {
    if (!scrollToLine || !taRef.current) return;
    const { line } = scrollToLine;
    const ta = taRef.current;
    const lines = value.split("\n");
    const upto = lines.slice(0, Math.max(0, line - 1)).join("\n").length;
    ta.focus();
    ta.setSelectionRange(upto, upto + (lines[line - 1]?.length ?? 0));
    // Approximate: scroll so the target line sits a third of the way down.
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || "20");
    ta.scrollTop = Math.max(0, (line - 1) * lineHeight - ta.clientHeight / 3);
    syncScroll();
  }, [scrollToLine]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tab inserts two spaces instead of leaving the editor — in a code box the
  // focus-change default is never what you meant.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: s, selectionEnd: en } = ta;
    const next = `${value.slice(0, s)}  ${value.slice(en)}`;
    onChange(next);
    requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
  }

  return (
    <div className="rs-editor-wrap">
      <div className="rs-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => {
          const mark = markByLine.get(i + 1);
          return (
            <div key={i} className={`rs-gutter-line${mark ? ` is-${mark.kind}` : ""}`} title={mark?.title}>
              {mark ? <span className="rs-gutter-dot" /> : null}
              {i + 1}
            </div>
          );
        })}
      </div>
      <div className="rs-code-stack">
        <pre className="rs-code rs-code-view" ref={preRef} aria-hidden="true">
          {/* hljs escapes its own output, so this is safe to inject. The
              trailing newline keeps the last line aligned while typing. */}
          <code dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
        </pre>
        <textarea
          ref={taRef}
          className="rs-code rs-code-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="soft"
          aria-label="LaTeX source"
        />
      </div>
    </div>
  );
}
