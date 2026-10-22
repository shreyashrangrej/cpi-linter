/**
 * CLI: lint CPI package exports from the command line / CI.
 *
 *   npm run cpi-lint -- <file.zip> [more files] [--format text|json|sarif|md] [--fail-on high] [--output report.sarif]
 *   npm run cpi-lint -- --sample        # lint the built-in demo package
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { lintPackage, toMarkdown, toSarif } from "../src/lib/linter/index";
import { SEVERITY_RANK, type LintReport, type Severity } from "../src/lib/linter/types";
import { buildSamplePackage, SAMPLE_FILE_NAME } from "../src/lib/sample/package";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value ?? fallback;
};
const format = opt("format", "text");
const failOn = opt("fail-on", "high") as Severity | "never";
const output = opt("output", "");
const useSample = args.includes("--sample");
const files = args.filter((a) => !a.startsWith("--"));

if (!useSample && files.length === 0) {
  console.error("Usage: cpi-lint <package.zip|iflow.zip|script.groovy>... [--format text|json|sarif|md] [--fail-on critical|high|medium|low|info|never] [--output file]");
  process.exit(2);
}

const COLORS: Record<Severity, string> = { critical: "\x1b[41;97m", high: "\x1b[31m", medium: "\x1b[33m", low: "\x1b[36m", info: "\x1b[90m" };
const tty = process.stdout.isTTY && !output;
const paint = (s: Severity, text: string) => (tty ? `${COLORS[s]}${text}\x1b[0m` : text);

function asText(r: LintReport): string {
  const out = [`\n${r.package?.name ?? r.source.fileName} — ${r.artifacts.length} artifacts, ${r.summary.filesScanned} files`];
  for (const w of r.warnings) out.push(`  warning: ${w}`);
  for (const f of r.findings) {
    const loc = `${f.artifact.name}/${f.file}${f.line ? `:${f.line}` : ""}`;
    out.push(`  ${paint(f.severity, f.severity.toUpperCase().padEnd(8))} ${f.ruleId}  ${loc}`, `           ${f.message}`);
  }
  const s = r.summary.bySeverity;
  out.push(`\n  ${r.summary.total} findings: ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} info`);
  return out.join("\n");
}

const reports: LintReport[] = [];
const inputs = useSample ? [{ name: SAMPLE_FILE_NAME, bytes: await buildSamplePackage() }] : await Promise.all(files.map(async (f) => ({ name: basename(f), bytes: new Uint8Array(await readFile(f)) })));
for (const input of inputs) {
  try {
    reports.push(await lintPackage(input.bytes, input.name));
  } catch (e) {
    console.error(`${input.name}: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}

let rendered: string;
if (format === "json") rendered = JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2);
else if (format === "sarif") {
  const logs = reports.map(toSarif);
  rendered = JSON.stringify({ ...logs[0], runs: logs.flatMap((l) => l.runs) }, null, 2);
} else if (format === "md") rendered = reports.map(toMarkdown).join("\n\n");
else rendered = reports.map(asText).join("\n");

if (output) {
  await writeFile(output, rendered);
  console.error(`Wrote ${format} report to ${output}`);
} else console.log(rendered);

if (failOn !== "never") {
  const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.high;
  if (reports.some((r) => r.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold))) process.exitCode ||= 1;
}
