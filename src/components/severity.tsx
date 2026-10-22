import type { Severity } from "@/lib/linter/types";

export const SEVERITY_STYLES: Record<Severity, { badge: string; dot: string; tile: string; label: string }> = {
  critical: {
    label: "Critical",
    badge: "bg-red-600 text-white",
    dot: "bg-red-600",
    tile: "border-red-600/40 text-red-700 dark:text-red-400",
  },
  high: {
    label: "High",
    badge: "bg-orange-500/15 text-orange-700 ring-1 ring-inset ring-orange-500/30 dark:text-orange-300",
    dot: "bg-orange-500",
    tile: "border-orange-500/40 text-orange-700 dark:text-orange-300",
  },
  medium: {
    label: "Medium",
    badge: "bg-amber-400/15 text-amber-800 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300",
    dot: "bg-amber-400",
    tile: "border-amber-400/50 text-amber-700 dark:text-amber-300",
  },
  low: {
    label: "Low",
    badge: "bg-sky-500/10 text-sky-700 ring-1 ring-inset ring-sky-500/30 dark:text-sky-300",
    dot: "bg-sky-500",
    tile: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  },
  info: {
    label: "Info",
    badge: "bg-zinc-500/10 text-zinc-600 ring-1 ring-inset ring-zinc-500/25 dark:text-zinc-300",
    dot: "bg-zinc-400",
    tile: "border-zinc-400/40 text-zinc-600 dark:text-zinc-300",
  },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_STYLES[severity].badge}`}
    >
      {SEVERITY_STYLES[severity].label}
    </span>
  );
}
