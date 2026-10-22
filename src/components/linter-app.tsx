"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import type { LintReport } from "@/lib/linter/types";
import { ReportView } from "./report-view";

type State =
  | { status: "idle" }
  | { status: "running"; fileName: string }
  | { status: "done"; report: LintReport }
  | { status: "error"; fileName: string; message: string };

const ACCEPT = ".zip,.iflw,.groovy,.gsh,.js,.prop,.properties,.xml,.xsl,.xslt,.json";
const MAX_BYTES = 200 * 1024 * 1024;

/** `children` is landing-page content, hidden while a report is shown. */
export function LinterApp({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const lint = useCallback(async (fileName: string, load: () => Promise<Uint8Array | ArrayBuffer>) => {
    setState({ status: "running", fileName });
    try {
      // Loaded on demand so the landing page stays light; all analysis stays in this tab.
      const [{ lintPackage }, bytes] = await Promise.all([import("@/lib/linter"), load()]);
      const report = await lintPackage(bytes, fileName);
      setState({ status: "done", report });
      window.scrollTo({ top: 0 });
    } catch (e) {
      setState({ status: "error", fileName, message: (e as Error).message || String(e) });
    }
  }, []);

  const lintFile = useCallback(
    (file: File) => {
      if (file.size > MAX_BYTES) {
        setState({ status: "error", fileName: file.name, message: `File is larger than ${MAX_BYTES / 1024 / 1024} MB.` });
        return;
      }
      void lint(file.name, () => file.arrayBuffer());
    },
    [lint],
  );

  const lintSample = useCallback(async () => {
    const { buildSamplePackage, SAMPLE_FILE_NAME } = await import("@/lib/sample/package");
    void lint(SAMPLE_FILE_NAME, buildSamplePackage);
  }, [lint]);

  const reset = () => {
    setState({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  if (state.status === "done") return <ReportView report={state.report} onReset={reset} />;

  return (
    <div className="space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) lintFile(file);
        }}
        className={`relative rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
          dragging
            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
            : "border-zinc-300 bg-white hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:border-zinc-500"
        }`}
      >
        {state.status === "running" ? (
          <div className="flex flex-col items-center gap-3" role="status">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Analysing <span className="font-medium text-zinc-900 dark:text-zinc-100">{state.fileName}</span>…
            </p>
          </div>
        ) : (
          <>
            <UploadIcon />
            <p className="mt-4 text-base font-medium text-zinc-900 dark:text-zinc-100">Drop an exported CPI package here</p>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Integration package <code className="font-mono text-xs">.zip</code>, a single iFlow export, or a loose{" "}
              <code className="font-mono text-xs">.iflw</code> / <code className="font-mono text-xs">.groovy</code> file
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              >
                Choose file
              </button>
              <button
                type="button"
                onClick={lintSample}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-700 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
              >
                Try the demo package
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              aria-label="CPI package file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) lintFile(file);
              }}
            />
          </>
        )}
      </div>

      {state.status === "error" && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" role="alert">
          <p className="font-semibold">Could not lint {state.fileName}</p>
          <p className="mt-1">{state.message}</p>
        </div>
      )}

      <p className="flex items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <LockIcon />
        Analysis runs entirely in your browser — the package is never uploaded.
      </p>

      {children}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg className="mx-auto h-10 w-10 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V3.75m0 0L7.5 8.25M12 3.75l4.5 4.5M3.75 15v3A2.25 2.25 0 0 0 6 20.25h12A2.25 2.25 0 0 0 20.25 18v-3" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 1 1 8 0v3.5" />
    </svg>
  );
}
