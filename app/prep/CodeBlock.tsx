"use client";

// Read view for a saved solution.
//
// The prep flow is paste-then-read, not type-in-the-browser, so the solution
// renders as highlighted, non-editable markup and only becomes a <textarea>
// while you're actually pasting. That avoids the usual trick of floating a
// transparent textarea over a highlighted <pre>, whose alignment drifts the
// moment a line wraps or a tab is involved.
//
// Only the five languages the picker offers are registered — importing
// highlight.js/lib/core rather than the bundle keeps the rest out.

import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import javascript from "highlight.js/lib/languages/javascript";
import go from "highlight.js/lib/languages/go";

/** Our language keys → highlight.js grammar names. */
const GRAMMAR: Record<string, string> = {
  python3: "python",
  java: "java",
  cpp: "cpp",
  javascript: "javascript",
  go: "go",
};

let registered = false;
function register(): void {
  if (registered) return;
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("go", go);
  registered = true;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export default function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const html = useMemo(() => {
    register();
    const grammar = GRAMMAR[lang] ?? "python";
    try {
      // hljs escapes HTML in its own output, so the result is safe to inject.
      // ignoreIllegals matters here: pasted snippets are often partial and a
      // strict parse would throw on a fragment that's perfectly readable.
      return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(code); // never lose the solution to a grammar error
    }
  }, [code, lang]);

  return (
    <pre className="prep-code-view">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
