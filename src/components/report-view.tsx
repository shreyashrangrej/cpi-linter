"use client";

import { type ReactNode, useMemo, useState } from "react";
import { toMarkdown, toSarif } from "@/lib/linter/export";
import { artifactTypeLabel, CATEGORIES, type Category, type Finding, type LintReport, SEVERITIES, type Severity } from "@/lib/linter/types";
import { SEVERITY_STYLES, SeverityBadge } from "./severity";

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export function ReportView({ report, onReset }: { report: LintReport; onReset: () => void }) {
  const [severities, setSeverities] = useState<Set<Severity>>(new Set());
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return report.findings.filter(
      (f) =>
        (severities.size === 0 || severities.has(f.severity)) &&
        (category === "all" || f.category === category) &&
        (!q || [f.ruleId, f.title, f.message, f.file, f.artifact.name, f.element?.name ?? ""].some((s) => s.toLowerCase().includes(q))),
    );
  }, [report.findings, severities, category, query]);

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; type: string; findings: Finding[] }>();
    for (const f of filtered) {
      const g = map.get(f.artifact.id) ?? { name: f.artifact.name, type: f.artifact.type, findings: [] };
      g.findings.push(f);
      map.set(f.artifact.id, g);
    }
    return [...map.entries()];
  }, [filtered]);

  const toggleSeverity = (s: Severity) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const base = (report.package?.name ?? report.source.fileName).replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "_");
  const title = report.package?.name ?? report.source.fileName;
  const clean = report.summary.total === 0;

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Lint report</p>
          <h2 className="mt-1 truncate text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {report.source.fileName} · {formatBytes(report.source.size)} · {report.artifacts.length} artifact
            {report.artifacts.length === 1 ? "" : "s"} · {report.summary.filesScanned} files scanned · {report.durationMs} ms
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExportButton onClick={() => download(`${base}.cpilint.json`, JSON.stringify(report, null, 2), "application/json")}>JSON</ExportButton>
          <ExportButton onClick={() => download(`${base}.sarif`, JSON.stringify(toSarif(report), null, 2), "application/sarif+json")}>SARIF</ExportButton>
          <ExportButton onClick={() => download(`${base}.cpilint.md`, toMarkdown(report), "text/markdown")}>Markdown</ExportButton>
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
          >
            Lint another package
          </button>
        </div>
      </div>

      {/* severity tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {SEVERITIES.map((s) => {
          const active = severities.has(s);
          const count = report.summary.bySeverity[s];
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleSeverity(s)}
              aria-pressed={active}
              disabled={count === 0}
              className={`rounded-xl border bg-white px-4 py-3 text-left transition disabled:cursor-default disabled:opacity-50 dark:bg-zinc-900 ${
                active ? `${SEVERITY_STYLES[s].tile} ring-2 ring-current` : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600"
              }`}
            >
              <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <span className={`h-2 w-2 rounded-full ${SEVERITY_STYLES[s].dot}`} />
                {SEVERITY_STYLES[s].label}
              </span>
              <span className="mt-1 block text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{count}</span>
            </button>
          );
        })}
      </div>

      {report.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-semibold">Warnings</p>
          <ul className="mt-1 list-disc pl-5">
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {clean ? (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 px-6 py-10 text-center dark:border-emerald-900 dark:bg-emerald-950/30">
          <p className="text-lg font-semibold text-emerald-800 dark:text-emerald-300">No findings</p>
          <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
            {report.summary.filesScanned} files across {report.artifacts.length} artifacts passed every rule.
          </p>
        </div>
      ) : (
        <>
          {/* filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900" role="tablist" aria-label="Category">
              <Tab active={category === "all"} onClick={() => setCategory("all")} label="All" count={report.summary.total} />
              {CATEGORIES.map((c) => (
                <Tab key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} label={c.label} count={report.summary.byCategory[c.id]} />
              ))}
            </div>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by rule, file, message…"
              className="min-w-48 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

          {groups.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-500">No findings match the current filters.</p>
          ) : (
            <div className="space-y-4">
              {groups.map(([id, g]) => (
                <details key={id} open className="group overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/80">
                    <span className="flex min-w-0 items-center gap-2">
                      <Chevron />
                      <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100">{g.name}</span>
                      <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        {artifactTypeLabel(g.type)}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {SEVERITIES.map((s) => {
                        const n = g.findings.filter((f) => f.severity === s).length;
                        return n ? (
                          <span key={s} className={`rounded px-1.5 text-xs font-semibold tabular-nums ${SEVERITY_STYLES[s].badge}`} title={SEVERITY_STYLES[s].label}>
                            {n}
                          </span>
                        ) : null;
                      })}
                    </span>
                  </summary>
                  <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {g.findings.map((f, i) => (
                      <FindingRow key={`${f.ruleId}-${f.file}-${f.line}-${i}`} finding={f} />
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </>
      )}

      <ArtifactInventory report={report} />
    </div>
  );
}

function FindingRow({ finding: f }: { finding: Finding }) {
  const fileName = f.file.split("/").pop();
  const dir = f.file.slice(0, f.file.length - (fileName?.length ?? 0));
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <SeverityBadge severity={f.severity} />
        <p className="min-w-0 flex-1 font-medium text-zinc-900 dark:text-zinc-100">{f.title}</p>
        <code className="shrink-0 font-mono text-xs text-zinc-500">{f.ruleId}</code>
      </div>
      <p className="mt-1.5 text-sm text-zinc-700 dark:text-zinc-300">{f.message}</p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-mono">
          <span className="text-zinc-400 dark:text-zinc-500">{dir}</span>
          <span className="text-zinc-700 dark:text-zinc-300">{fileName}</span>
          {f.line ? `:${f.line}` : ""}
        </span>
        {f.element && (
          <span>
            · {f.element.type ? `${f.element.type} ` : ""}
            <span className="font-medium text-zinc-700 dark:text-zinc-300">{f.element.name ?? f.element.id}</span>
          </span>
        )}
      </p>
      {f.snippet && (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 dark:bg-black">
          {f.line && <span className="mr-3 select-none text-zinc-500">{f.line}</span>}
          {f.snippet}
        </pre>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer select-none text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">How to fix</summary>
        <p className="mt-1.5 rounded-lg bg-indigo-50 px-3 py-2 text-zinc-700 dark:bg-indigo-950/30 dark:text-zinc-300">{f.recommendation}</p>
      </details>
    </li>
  );
}

function ArtifactInventory({ report }: { report: LintReport }) {
  return (
    <details className="rounded-xl border border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="cursor-pointer px-4 py-3 font-medium text-zinc-700 dark:text-zinc-300">
        Scanned artifacts ({report.artifacts.length})
      </summary>
      <div className="overflow-x-auto border-t border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Artifact</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Version</th>
              <th className="px-4 py-2 text-right font-medium">iFlows</th>
              <th className="px-4 py-2 text-right font-medium">Scripts</th>
              <th className="px-4 py-2 text-right font-medium">Files</th>
              <th className="px-4 py-2 text-right font-medium">Findings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {report.artifacts.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">{a.name}</td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{artifactTypeLabel(a.type)}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-500">{a.version ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{a.iflows}</td>
                <td className="px-4 py-2 text-right tabular-nums">{a.scripts}</td>
                <td className="px-4 py-2 text-right tabular-nums">{a.files.length}</td>
                <td className="px-4 py-2 text-right tabular-nums">{report.findings.filter((f) => f.artifact.id === a.id).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Tab({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-sm font-medium transition ${
        active ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      }`}
    >
      {label} <span className="ml-1 tabular-nums text-zinc-400">{count}</span>
    </button>
  );
}

function ExportButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-700 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
    >
      <span className="sr-only">Download </span>
      {children}
    </button>
  );
}

function Chevron() {
  return (
    <svg className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.17 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
    </svg>
  );
}
