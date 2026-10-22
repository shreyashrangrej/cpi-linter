import Link from "next/link";
import { LinterApp } from "@/components/linter-app";
import { RULES } from "@/lib/linter/rules";
import { CATEGORIES, type Category } from "@/lib/linter/types";

const CATEGORY_BLURBS: Record<Category, string> = {
  credentials: "Passwords, tokens, Basic auth headers and keys in scripts, Content Modifiers, adapters and parameters.prop.",
  "exception-handling": "Integration processes without an Exception Subprocess, subprocesses that swallow errors, empty catch blocks.",
  logging: "Payload attachments written for every message, inside loops, or into MPL properties.",
  groovy: "getBody(String), parseText(), full stream reads, trust-all TLS, Eval, sleep and more.",
};

export default function Home() {
  return (
    <div className="space-y-12">
      <section className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
          Lint SAP Cloud Integration packages
        </h1>
        <p className="mt-3 text-base text-zinc-600 dark:text-zinc-400">
          Upload an exported CPI package and get flagged for hardcoded credentials, missing exception subprocesses, unbounded
          logging and Groovy that reads large payloads into memory.
        </p>
      </section>

      <LinterApp>
        <section className="mt-12 grid gap-4 sm:grid-cols-2">
          {CATEGORIES.map((c) => (
            <div key={c.id} className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">{c.label}</h2>
                <span className="text-xs text-zinc-500">{RULES.filter((r) => r.category === c.id).length} rules</span>
              </div>
              <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{CATEGORY_BLURBS[c.id]}</p>
            </div>
          ))}
        </section>

        <section className="mt-12 rounded-xl border border-zinc-200 bg-white p-5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Use it in CI</h2>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            POST a package to the API (JSON, SARIF or Markdown), or run the bundled CLI, which exits non-zero when findings meet the
            threshold. See the <Link href="/rules" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">rule reference</Link>{" "}
            for suppression comments.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-100">
            {`curl -F file=@MyPackage.zip "http://localhost:3000/api/lint?format=sarif" > cpi.sarif

npm run cpi-lint -- MyPackage.zip --fail-on high --format sarif --output cpi.sarif`}
          </pre>
        </section>
      </LinterApp>
    </div>
  );
}
