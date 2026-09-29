"use client";

// The proof sheet.
//
// This replaces an <iframe> pointed at the PDF, which was wrong for one
// specific reason: every recompile is a new URL, so the browser's viewer
// reloaded and threw you back to the top of page one. With auto-compile on that
// means the page jumps away from you every time you stop typing. Overleaf
// doesn't do that, and neither does this.
//
// pdf.js renders into canvases we own, so a recompile swaps the pixels and
// leaves the scroll position, the zoom and the page you were reading exactly
// where they were. The old render stays on screen while the new one rasterises,
// so there is no white flash between drafts.
//
// ── Concurrency ────────────────────────────────────────────────────────────
// pdf.js refuses two renders into one canvas, and it means it: cancelling a
// render task does NOT release the canvas synchronously, it releases it when
// the cancelled task's promise settles. Three rules keep that safe here:
//
//   1. Every pass runs on one promise chain, so two passes never overlap.
//   2. A pass waits for the previous pass's tasks to actually settle, not just
//      to be cancelled.
//   3. A sequence number is re-checked before every draw, because each `await`
//      in between is a window where a newer pass could have been requested.
//
// The first version of this file had none of them and a feedback loop besides —
// the render computed a scale and wrote it to state the render depended on,
// which started a second pass against the same canvas mid-draw.

import { useCallback, useEffect, useRef, useState } from "react";

type FitMode = "width" | "page" | "manual";

interface PageView {
  canvas: HTMLCanvasElement;
  wrap: HTMLDivElement;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DESK_PADDING = 48;

export default function PdfViewer({
  src,
  busy,
  onPages,
}: {
  /** URL of the PDF. Changing it re-renders in place. */
  src: string | null;
  /** True while a compile is running — dims the sheet rather than clearing it. */
  busy?: boolean;
  onPages?: (n: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<PageView[]>([]);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const docRef = useRef<any>(null);
  // destroy() lives on the loading task, not the document proxy — keep it so a
  // superseded document can release its worker.
  const loadingRef = useRef<any>(null);
  const tasksRef = useRef<any[]>([]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // One counter, two jobs: a pass that has been superseded (five recompiles in
  // ten seconds) skips its work instead of drawing a frame nobody will see, and
  // bumping it on unmount stops an in-flight pass painting into a dead canvas.
  const seqRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const [fit, setFit] = useState<FitMode>("width");
  const [manualScale, setManualScale] = useState(1);
  // Display only, and deliberately not an input to rendering: writing back the
  // scale a render just computed is what caused overlapping passes before.
  const [shownScale, setShownScale] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [current, setCurrent] = useState(1);
  const [error, setError] = useState<string | null>(null);

  /** Cancel everything in flight and wait for pdf.js to actually let go. */
  const drainTasks = useCallback(async () => {
    const tasks = tasksRef.current;
    tasksRef.current = [];
    for (const task of tasks) {
      try {
        task.cancel();
      } catch {
        /* already finished */
      }
    }
    // A cancelled task rejects; settling is what frees the canvas.
    await Promise.allSettled(tasks.map((task) => task.promise));
  }, []);

  const renderPass = useCallback(
    async (seq: number) => {
      const doc = docRef.current;
      const sheet = sheetRef.current;
      const box = scrollRef.current;
      if (!doc || !sheet || !box) return;
      if (seq !== seqRef.current) return;

      await drainTasks();
      if (seq !== seqRef.current) return;

      const first = await doc.getPage(1);
      const base = first.getViewport({ scale: 1 });
      const fitWidth = Math.max(0.2, (box.clientWidth - DESK_PADDING) / base.width);
      const fitPage = Math.max(0.2, Math.min(fitWidth, (box.clientHeight - DESK_PADDING) / base.height));
      const effective = fit === "manual" ? manualScale : fit === "width" ? fitWidth : fitPage;
      setShownScale(effective);

      // Cap the backing store so a 3x zoom on a retina display doesn't allocate
      // a canvas the browser refuses to paint.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      for (let n = 1; n <= doc.numPages; n++) {
        if (seq !== seqRef.current) return;
        const page = await doc.getPage(n);
        if (seq !== seqRef.current) return;

        const viewport = page.getViewport({ scale: effective });
        let view = viewsRef.current[n - 1];
        if (!view) {
          const wrap = document.createElement("div");
          wrap.className = "rs-sheet";
          const canvas = document.createElement("canvas");
          wrap.appendChild(canvas);
          sheet.appendChild(wrap);
          view = { canvas, wrap };
          viewsRef.current[n - 1] = view;
        }

        view.wrap.style.width = `${Math.floor(viewport.width)}px`;
        view.wrap.style.height = `${Math.floor(viewport.height)}px`;
        view.canvas.width = Math.floor(viewport.width * dpr);
        view.canvas.height = Math.floor(viewport.height * dpr);
        view.canvas.style.width = `${Math.floor(viewport.width)}px`;
        view.canvas.style.height = `${Math.floor(viewport.height)}px`;

        const ctx = view.canvas.getContext("2d");
        if (!ctx) continue;

        // Last check before handing the canvas over.
        if (seq !== seqRef.current) return;
        const task = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        tasksRef.current.push(task);

        try {
          await task.promise;
        } catch (e) {
          // A cancelled render is the normal result of typing while it draws.
          if ((e as { name?: string }).name !== "RenderingCancelledException") throw e;
          return;
        }
      }

      // Pages dropped by a shorter draft (two pages back down to one).
      while (viewsRef.current.length > doc.numPages) {
        viewsRef.current.pop()?.wrap.remove();
      }
    },
    [fit, manualScale, drainTasks],
  );

  /** Every render goes through this one chain. Never two passes at once. */
  const schedule = useCallback(() => {
    const seq = ++seqRef.current;
    queueRef.current = queueRef.current
      .then(() => renderPass(seq))
      .catch((e) => setError((e as Error).message));
    return queueRef.current;
  }, [renderPass]);

  // Load. Crucially this does not touch the scroll container — the sheet stays
  // put and the pixels change underneath it.
  useEffect(() => {
    if (!src) return;
    let cancelled = false;

    void (async () => {
      try {
        // The legacy build, deliberately: pdf.js 6's default bundle uses ES2025
        // iterator helpers, which only very recent browsers have and which fail
        // at runtime rather than at build time. The worker in /public matches.
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const loading = pdfjs.getDocument({ url: src });
        const doc = await loading.promise;
        if (cancelled) {
          void loading.destroy();
          return;
        }

        const previous = loadingRef.current;
        loadingRef.current = loading;
        docRef.current = doc;
        setPageCount(doc.numPages);
        onPages?.(doc.numPages);
        setError(null);

        await schedule();
        // Only once the new document has drawn: destroying the old one earlier
        // would cancel the render that is painting from it.
        if (previous) void previous.destroy();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom and fit changes redraw through the same queue.
  useEffect(() => {
    if (docRef.current) void schedule();
  }, [fit, manualScale, schedule]);

  // Re-fit on resize — dragging the split divider is the common case.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || fit === "manual") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (docRef.current) void schedule();
      });
    });
    observer.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fit, schedule]);

  // Tear down so a pending pass can't draw into a detached canvas.
  useEffect(() => {
    return () => {
      seqRef.current++;
      void drainTasks();
      void loadingRef.current?.destroy();
      loadingRef.current = null;
      docRef.current = null;
    };
  }, [drainTasks]);

  // Which page am I looking at — for the "2 of 2" readout.
  function onScroll(): void {
    const box = scrollRef.current;
    if (!box || !viewsRef.current.length) return;
    const mid = box.scrollTop + box.clientHeight / 2;
    let n = 1;
    for (let i = 0; i < viewsRef.current.length; i++) {
      if (viewsRef.current[i].wrap.offsetTop <= mid) n = i + 1;
    }
    setCurrent(n);
  }

  function zoomBy(direction: 1 | -1): void {
    const above = ZOOM_STEPS.findIndex((z) => z > shownScale + 0.001);
    const next =
      direction === 1
        ? ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, above === -1 ? ZOOM_STEPS.length - 1 : above)]
        : ZOOM_STEPS[Math.max(0, (above === -1 ? ZOOM_STEPS.length : above) - 2)];
    setManualScale(next);
    setFit("manual");
  }

  return (
    <div className="rs-viewer">
      <div className={`rs-desk${busy ? " is-busy" : ""}`} ref={scrollRef} onScroll={onScroll}>
        <div className="rs-sheets" ref={sheetRef} />
        {!src && <div className="rs-desk-empty">Compile to see the page.</div>}
        {error && <div className="rs-desk-empty">Couldn&rsquo;t draw the PDF: {error}</div>}
      </div>

      <div className="rs-viewbar">
        <button className="rs-icon" onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">−</button>
        <span className="rs-zoom">{Math.round(shownScale * 100)}%</span>
        <button className="rs-icon" onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">+</button>
        <div className="rs-viewbar-sep" />
        <button className={`rs-icon is-text${fit === "width" ? " active" : ""}`} onClick={() => setFit("width")}>Fit width</button>
        <button className={`rs-icon is-text${fit === "page" ? " active" : ""}`} onClick={() => setFit("page")}>Whole page</button>
        <div className="rs-viewbar-sep" />
        <span className="rs-pageno">{current} of {pageCount || 1}</span>
      </div>
    </div>
  );
}
