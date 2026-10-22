import { isSecretName, looksLikeSecretValue, scanForSecretAssignments, scanForSecretPatterns, scanXmlSecretElements, type SecretHit } from "../secrets";
import { computeLineStarts, lineOf } from "../source";
import type { RawFinding } from "./common";

function toFindings(text: string, hits: SecretHit[]): RawFinding[] {
  const lineStarts = computeLineStarts(text);
  return hits.map((h) => ({
    ruleId: h.ruleId,
    message: h.message,
    line: lineOf(lineStarts, h.offset),
    secret: h.secret,
    ...(h.severity ? { severity: h.severity } : {}),
  }));
}

/** parameters.prop: Java properties holding externalized parameter values. */
export function checkProperties(text: string): RawFinding[] {
  const findings: RawFinding[] = toFindings(text, scanForSecretPatterns(text));
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) return;
    const m = line.match(/^((?:\\.|[^=:\s\\])+)\s*[=:]\s*(.*)$/);
    if (!m) return;
    const key = m[1].replace(/\\(.)/g, "$1");
    const value = m[2].replace(/\\(.)/g, "$1");
    if (isSecretName(key) && looksLikeSecretValue(value)) {
      findings.push({
        ruleId: "CPI-CRED-006",
        message: `Externalized parameter "${key}" ships with a literal secret value.`,
        line: i + 1,
        secret: m[2],
      });
    }
  });
  return findings;
}

export function checkJson(text: string): RawFinding[] {
  return toFindings(text, [...scanForSecretPatterns(text), ...scanForSecretAssignments(text)]);
}

export function checkXml(text: string): RawFinding[] {
  return toFindings(text, [...scanForSecretPatterns(text), ...scanXmlSecretElements(text)]);
}

export function checkText(text: string): RawFinding[] {
  return toFindings(text, scanForSecretPatterns(text));
}
