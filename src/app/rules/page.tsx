import type { Metadata } from "next";
import { SeverityBadge } from "@/components/severity";
import { RULES } from "@/lib/linter/rules";
import { CATEGORIES } from "@/lib/linter/types";

export const metadata: Metadata = { title: "Rules — CPI Linter" };

export default function RulesPage() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Rules</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          {RULES.length} rules across iFlow models (<code className="font-mono text-xs">.iflw</code>), Groovy/JavaScript scripts,{" "}
          <code className="font-mono text-xs">parameters.prop</code> and resource files. Severities shown are defaults; some rules
          adjust them based on context (e.g. logging that only runs inside an Exception Subprocess is downgraded).
        </p>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Suppressing findings</h2>
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          Add a comment to a script or XML resource. Omit rule IDs to suppress every rule.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-100">
          {`// cpilint-disable-file CPI-GRV-001
def body = message.getBody(String) // cpilint-disable-line CPI-GRV-001
// cpilint-disable-next-line CPI-LOG-001 CPI-LOG-005
messageLog.addAttachmentAsString("Payload", body, "text/plain")`}
        </pre>
      </section>

      {CATEGORIES.map((c) => (
        <section key={c.id}>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{c.label}</h2>
          <div className="mt-3 divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {RULES.filter((r) => r.category === c.id).map((r) => (
              <article key={r.id} id={r.id} className="scroll-mt-20 px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <SeverityBadge severity={r.severity} />
                  <h3 className="font-medium text-zinc-900 dark:text-zinc-100">{r.title}</h3>
                  <code className="ml-auto font-mono text-xs text-zinc-500">{r.id}</code>
                </div>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{r.description}</p>
                <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                  <span className="font-medium text-indigo-600 dark:text-indigo-400">Fix: </span>
                  {r.recommendation}
                </p>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
