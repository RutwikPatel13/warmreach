"use client";

// Gmail-style "Schedule send" popover: a few quick picks plus a custom
// date/time. Calls onSchedule with an absolute ISO instant; the parent decides
// which draft(s) it applies to. Mirrors the Applications page's schedule control
// and reuses the shared .sched-* / .send-split styles.

import { useEffect, useMemo, useRef, useState } from "react";

export interface SchedulePreset {
  label: string;
  date: Date;
}

function localTimeZoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "long" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// "Jul 24, 8:00 AM" in the viewer's locale + timezone.
export function formatSendAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Quick picks, computed from now and filtered to future instants.
function schedulePresets(now = new Date()): SchedulePreset[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const daysToMonday = (1 - now.getDay() + 7) % 7 || 7;
  const monday = at(daysToMonday, 8);
  const weekday = monday.toLocaleDateString(undefined, { weekday: "long" });
  const inTwoHours = new Date(now.getTime() + 2 * 3_600_000);
  const out: SchedulePreset[] = [
    { label: "In 2 hours", date: inTwoHours },
    { label: "Tomorrow morning", date: at(1, 8) },
    { label: "Tomorrow afternoon", date: at(1, 13) },
    { label: `${weekday} morning`, date: monday },
  ];
  return out.filter((p) => p.date.getTime() > now.getTime());
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduleMenu({
  onSchedule,
  disabled,
  label = "Schedule",
  align = "right",
}: {
  onSchedule: (iso: string) => void | Promise<void>;
  disabled?: boolean;
  label?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customVal, setCustomVal] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const tz = useMemo(() => localTimeZoneLabel(), []);
  const presets = useMemo(() => schedulePresets(), [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(iso: string) {
    setOpen(false);
    setCustom(false);
    onSchedule(iso);
  }

  return (
    <div className="sched" ref={ref}>
      <button
        type="button"
        className="ghost sched-caret"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setCustom(false);
          setCustomVal(toLocalInputValue(schedulePresets()[0]?.date ?? new Date(Date.now() + 3_600_000)));
          setOpen((o) => !o);
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div className={`sched-menu ${align}`} role="menu">
          <div className="sched-head">Schedule send</div>
          {tz && <div className="sched-tz">{tz}</div>}
          {!custom ? (
            <>
              {presets.map((p) => (
                <button type="button" key={p.label} className="sched-opt" role="menuitem" onClick={() => choose(p.date.toISOString())}>
                  <span className="sched-opt-label">{p.label}</span>
                  <span className="sched-opt-time">{formatSendAt(p.date.toISOString())}</span>
                </button>
              ))}
              <button type="button" className="sched-opt sched-custom" onClick={() => setCustom(true)}>
                <span className="sched-opt-label">Pick date &amp; time…</span>
              </button>
            </>
          ) : (
            <div className="sched-picker">
              <input
                type="datetime-local"
                value={customVal}
                min={toLocalInputValue(new Date())}
                onChange={(e) => setCustomVal(e.target.value)}
              />
              <div className="sched-picker-actions">
                <button type="button" className="ghost" onClick={() => setCustom(false)}>
                  Back
                </button>
                <button
                  type="button"
                  disabled={!customVal || new Date(customVal).getTime() <= Date.now()}
                  onClick={() => choose(new Date(customVal).toISOString())}
                >
                  Schedule send
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
