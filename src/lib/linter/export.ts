import { RULES } from "./rules";
import { CATEGORIES, type LintReport, type Severity } from "./types";

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

/** GitHub code scanning uses this 0–10 score to rank security alerts. */
const SECURITY_SCORE: Record<Severity, string> = { critical: "9.5", high: "7.5", medium: "5.0", low: "3.0", info: "1.0" };

/** SARIF 2.1.0 log, consumable by GitHub code scanning, Azure DevOps and most IDEs. */
export function toSarif(report: LintReport) {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "cpi-linter",
            rules: RULES.map((r) => ({
              id: r.id,
              name: r.title.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")),
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
              help: { text: r.recommendation, markdown: r.recommendation },
              defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
              properties: {
                tags: [r.category, ...(r.category === "credentials" ? ["security"] : [])],
                "security-severity": SECURITY_SCORE[r.severity],
              },
            })),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.ruleId,
          level: SARIF_LEVEL[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: `${f.artifact.name}/${f.file}`.replace(/\s/g, "%20") },
                ...(f.line ? { region: { startLine: f.line, ...(f.column ? { startColumn: f.column } : {}) } } : {}),
              },
              ...(f.element ? { logicalLocations: [{ name: f.element.name ?? f.element.id, kind: f.element.type }] } : {}),
            },
          ],
          properties: { severity: f.severity, category: f.category, artifactType: f.artifact.type },
        })),
      },
    ],
  };
}

export function toMarkdown(report: LintReport): string {
  const title = report.package?.name ?? report.source.fileName;
  const s = report.summary.bySeverity;
  const lines = [
    `# CPI lint report — ${title}`,
    "",
    `${report.summary.total} findings across ${report.artifacts.length} artifacts (${report.summary.filesScanned} files scanned).`,
    "",
    `| Critical | High | Medium | Low | Info |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${s.critical} | ${s.high} | ${s.medium} | ${s.low} | ${s.info} |`,
    "",
  ];
  for (const cat of CATEGORIES) {
    const list = report.findings.filter((f) => f.category === cat.id);
    if (!list.length) continue;
    lines.push(`## ${cat.label} (${list.length})`, "");
    for (const f of list) {
      const loc = `${f.artifact.name}/${f.file}${f.line ? `:${f.line}` : ""}`;
      lines.push(`- **${f.severity.toUpperCase()}** \`${f.ruleId}\` ${f.title} — ${f.message}  `, `  \`${loc}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}
