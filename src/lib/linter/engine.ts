import { extensionOf, extractPackage } from "./archive";
import type { RawFinding } from "./checks/common";
import { checkIflow, type ScriptUsage } from "./checks/iflow";
import { checkJson, checkProperties, checkText, checkXml } from "./checks/resources";
import { checkScript } from "./checks/script";
import { RULE_BY_ID } from "./rules";
import { maskSecret } from "./secrets";
import { computeLineStarts, lineText } from "./source";
import {
  CATEGORIES,
  type Category,
  type Finding,
  type LintReport,
  SEVERITIES,
  SEVERITY_RANK,
  type Severity,
  type SourceFile,
} from "./types";

const SCRIPT_EXT = new Set(["groovy", "gsh", "gy", "js"]);
const XML_EXT = new Set(["xml", "xsl", "xslt", "mmap", "edmx", "wsdl"]);
const MAX_SNIPPET = 200;

interface FileResult {
  file: SourceFile;
  raw: RawFinding[];
}

function checkFile(file: SourceFile, scriptUsages: ScriptUsage[], warnings: string[]): RawFinding[] {
  const ext = extensionOf(file.path);
  if (ext === "iflw") {
    const r = checkIflow(file.text);
    if (r.error) warnings.push(`${file.artifact.name}/${file.path}: ${r.error}`);
    scriptUsages.push(...r.scripts);
    return r.findings;
  }
  if (SCRIPT_EXT.has(ext)) return checkScript(file.text);
  if (ext === "prop" || ext === "properties") return checkProperties(file.text);
  if (ext === "json") return checkJson(file.text);
  if (XML_EXT.has(ext)) return checkXml(file.text);
  return checkText(file.text);
}

/** Lint already-extracted files. Exposed separately so it can be tested without zips. */
export function lintFiles(files: SourceFile[], warnings: string[] = []): Finding[] {
  const usagesByArtifact = new Map<string, ScriptUsage[]>();
  const results: FileResult[] = [];

  for (const file of files) {
    const usages = usagesByArtifact.get(file.artifact.id) ?? [];
    usagesByArtifact.set(file.artifact.id, usages);
    try {
      results.push({ file, raw: checkFile(file, usages, warnings) });
    } catch (e) {
      warnings.push(`${file.artifact.name}/${file.path}: linter error — ${(e as Error).message}`);
    }
  }

  const findings: Finding[] = [];
  for (const { file, raw } of results) {
    const usages = (usagesByArtifact.get(file.artifact.id) ?? []).filter((u) => file.path.split("/").pop() === u.script);
    const kept = dedupeSecrets(applySuppressions(file.text, raw));
    // mask every secret seen in the file, including ones from suppressed/deduplicated findings
    const secrets = [...new Set(raw.flatMap((f) => (f.secret ? [f.secret] : [])))].sort((a, b) => b.length - a.length);
    const lineStarts = computeLineStarts(file.text);
    const isXml = /\.(iflw|xml|xsl|xslt|mmap)$/i.test(file.path);

    for (const f of kept) {
      const rule = RULE_BY_ID[f.ruleId];
      let severity: Severity = f.severity ?? rule.severity;
      let message = f.message;

      if ((f.ruleId === "CPI-LOG-001" || f.ruleId === "CPI-LOG-002") && usages.length && usages.every((u) => u.inExceptionSubprocess)) {
        severity = "low";
        message += " The script only runs inside an Exception Subprocess, so this happens only for failed messages.";
      } else if (rule.category === "logging" && usages.length) {
        const steps = usages.map((u) => `"${u.stepName ?? u.stepId}"`).join(", ");
        message += ` Used by step ${steps}.`;
      }

      findings.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity,
        message,
        recommendation: rule.recommendation,
        artifact: file.artifact,
        file: file.path,
        line: f.line,
        column: f.column,
        snippet: f.line ? snippetFor(lineText({ text: file.text, lineStarts }, f.line), f, secrets, isXml) : undefined,
        element: f.element,
      });
    }
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.artifact.name.localeCompare(b.artifact.name) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function snippetFor(line: string, f: RawFinding, secrets: string[], isXml: boolean): string {
  // Content Modifier tables are escaped XML inside XML; unescape for readability
  let s = isXml && line.includes("&lt;") ? xmlUnescape(line) : line;
  // Long lines (minified XML, Content Modifier tables): show a window around the interesting part.
  if (s.length > MAX_SNIPPET) {
    let at = f.column ? f.column - 1 : -1;
    if (f.secret) at = Math.max(s.indexOf(f.secret), s.indexOf(xmlEscape(f.secret)));
    const start = Math.max(0, at - 60);
    s = (start > 0 ? "…" : "") + s.slice(start, start + MAX_SNIPPET) + (start + MAX_SNIPPET < s.length ? "…" : "");
  }
  for (const secret of secrets) {
    const masked = maskSecret(secret);
    s = s.split(secret).join(masked);
    const escaped = xmlEscape(secret);
    if (escaped !== secret) s = s.split(escaped).join(masked);
  }
  return s.trim();
}

/** Honour `cpilint-disable-file|line|next-line [RULE-IDS]` comments. */
function applySuppressions(text: string, raw: RawFinding[]): RawFinding[] {
  if (!text.includes("cpilint-disable")) return raw;
  const fileRules: (string[] | "all")[] = [];
  const lineRules = new Map<number, (string[] | "all")[]>();
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/cpilint-disable-(file|line|next-line)\b(.*)/);
    if (!m) return;
    const ids = m[2].match(/CPI-[A-Z]+-\d{3}/g);
    const rules = ids ? ids : "all";
    if (m[1] === "file") fileRules.push(rules);
    else {
      const target = m[1] === "line" ? i + 1 : i + 2;
      lineRules.set(target, [...(lineRules.get(target) ?? []), rules]);
    }
  });
  const hits = (list: (string[] | "all")[] | undefined, id: string) => !!list?.some((r) => r === "all" || r.includes(id));
  return raw.filter((f) => !hits(fileRules, f.ruleId) && !(f.line && hits(lineRules.get(f.line), f.ruleId)));
}

/** The same secret is often caught by a structural and a pattern rule; keep the most severe one. */
function dedupeSecrets(raw: RawFinding[]): RawFinding[] {
  const out: RawFinding[] = [];
  const sev = (f: RawFinding) => SEVERITY_RANK[f.severity ?? RULE_BY_ID[f.ruleId].severity];
  for (const f of raw) {
    if (!f.secret) {
      out.push(f);
      continue;
    }
    const i = out.findIndex(
      (o) => o.secret && o.line === f.line && (o.secret.includes(f.secret!) || f.secret!.includes(o.secret)),
    );
    if (i === -1) out.push(f);
    else if (sev(f) > sev(out[i])) out[i] = f;
  }
  return out;
}

export function summarize(findings: Finding[]) {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0])) as Record<Category, number>;
  for (const f of findings) {
    bySeverity[f.severity]++;
    byCategory[f.category]++;
  }
  return { total: findings.length, bySeverity, byCategory };
}

/** Extract and lint an uploaded package / iFlow archive / loose file. */
export async function lintPackage(data: Uint8Array | ArrayBuffer, fileName: string): Promise<LintReport> {
  const started = Date.now();
  const extracted = await extractPackage(data, fileName);
  const warnings = [...extracted.warnings];
  const findings = lintFiles(extracted.files, warnings);
  return {
    source: { fileName, size: data.byteLength },
    package: extracted.package,
    artifacts: extracted.artifacts,
    findings,
    summary: { ...summarize(findings), filesScanned: extracted.files.length },
    warnings,
    durationMs: Date.now() - started,
  };
}
