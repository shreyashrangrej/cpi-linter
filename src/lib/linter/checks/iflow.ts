import { XMLParser } from "fast-xml-parser";
import {
  isSecretName,
  looksLikeSecretValue,
  scanForSecretAssignments,
  scanForSecretPatterns,
  scanXmlSecretElements,
} from "../secrets";
import { computeLineStarts, lineOf } from "../source";
import type { RawFinding } from "./common";

/** A parsed XML element: child arrays keyed by local tag name, attributes as `@_name`. */
type XNode = { [key: string]: XNode[] | string[] | string | undefined };

export interface ScriptUsage {
  /** Script file name as referenced by the step, e.g. `script1.groovy`. */
  script: string;
  stepId: string;
  stepName?: string;
  processName?: string;
  inExceptionSubprocess: boolean;
}

export interface IflowResult {
  findings: RawFinding[];
  scripts: ScriptUsage[];
  /** Set when the file could not be parsed as an iFlow. */
  error?: string;
}

const META = XMLParser.getMetaDataSymbol() as unknown as symbol;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  captureMetaData: true,
  isArray: (_tag, _path, _leaf, isAttribute) => !isAttribute,
  maxNestedTags: 500,
});

/** Tags inside a (sub)process that are wiring rather than processing steps. */
const STRUCTURAL = new Set(["extensionElements", "startEvent", "endEvent", "sequenceFlow", "incoming", "outgoing", "documentation", "#text"]);

const STEP_TYPES: Record<string, string> = {
  Enricher: "Content Modifier",
  Script: "Script",
  ExternalCall: "Request Reply",
  ProcessCallElement: "Process Call",
  Mapping: "Message Mapping",
  XSLTMapping: "XSLT Mapping",
  DBstorage: "Data Store",
  Persist: "Persist",
};

const children = (node: XNode | undefined, tag: string): XNode[] =>
  ((node?.[tag] as XNode[] | undefined) ?? []).filter((c): c is XNode => typeof c === "object" && c !== null);

const text = (v: unknown): string => {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v) return text((v as XNode)["#text"]);
  return "";
};

const attr = (node: XNode, name: string) => (typeof node[`@_${name}`] === "string" ? (node[`@_${name}`] as string) : undefined);

function props(node: XNode): { key: string; value: string; node: XNode }[] {
  return children(node, "extensionElements").flatMap((ext) =>
    children(ext, "property").map((p) => ({ key: text(p.key), value: text(p.value), node: p })),
  );
}

function prop(node: XNode, key: string): string | undefined {
  return props(node).find((p) => p.key === key)?.value;
}

function startIndex(node: XNode): number | undefined {
  return (node as unknown as Record<symbol, { startIndex?: number } | undefined>)[META]?.startIndex;
}

const isExceptionSubprocess = (sp: XNode) =>
  attr(sp, "triggeredByEvent") === "true" ||
  prop(sp, "activityType") === "ErrorEventSubProcessTemplate" ||
  children(sp, "startEvent").some((s) => "errorEventDefinition" in s);

const endsWithError = (sp: XNode) =>
  children(sp, "endEvent").some((e) => "errorEventDefinition" in e || "escalationEventDefinition" in e);

const hasSteps = (sp: XNode) => Object.keys(sp).some((k) => !k.startsWith("@_") && !STRUCTURAL.has(k));

export function checkIflow(xml: string): IflowResult {
  const lineStarts = computeLineStarts(xml);
  const findings: RawFinding[] = [];
  const scripts: ScriptUsage[] = [];

  let doc: XNode;
  try {
    doc = parser.parse(xml) as XNode;
  } catch (e) {
    return { findings, scripts, error: `Could not parse iFlow XML: ${(e as Error).message}` };
  }
  const definitions = children(doc, "definitions")[0];
  if (!definitions) return { findings, scripts, error: "File has no BPMN <definitions> root." };

  const lineFor = (node: XNode): number | undefined => {
    const idx = startIndex(node);
    if (idx !== undefined) return lineOf(lineStarts, idx);
    const id = attr(node, "id");
    const at = id ? xml.indexOf(`id="${id}"`) : -1;
    return at >= 0 ? lineOf(lineStarts, at) : undefined;
  };
  /** Line of a property's secret value (handles single- and double-escaped XML), else the node's line. */
  const lineForSecret = (node: XNode, secret: string): number | undefined => {
    const from = startIndex(node);
    if (from !== undefined) {
      for (const needle of [secret, xmlEscape(secret), xmlEscape(xmlEscape(secret))]) {
        const at = xml.indexOf(needle, from);
        if (at >= 0) return lineOf(lineStarts, at);
      }
    }
    return lineFor(node);
  };
  const elementOf = (node: XNode, type: string) => ({
    id: attr(node, "id") ?? "?",
    name: attr(node, "name") ?? prop(node, "Name"),
    type,
  });

  // ── exception handling ────────────────────────────────────────────────
  for (const process of children(definitions, "process")) {
    const name = attr(process, "name") ?? attr(process, "id") ?? "process";
    const isLocal = prop(process, "processType") === "directCall" || /local/i.test(name);
    const subprocesses = children(process, "subProcess").filter(isExceptionSubprocess);
    const element = elementOf(process, isLocal ? "Local Integration Process" : "Integration Process");

    if (subprocesses.length === 0) {
      findings.push({
        ruleId: isLocal ? "CPI-EXC-002" : "CPI-EXC-001",
        message: `"${name}" has no Exception Subprocess.`,
        line: lineFor(process),
        element,
      });
    }

    for (const sp of subprocesses) {
      const spName = attr(sp, "name") ?? "Exception Subprocess";
      const spElement = elementOf(sp, "Exception Subprocess");
      if (!hasSteps(sp) && !endsWithError(sp)) {
        findings.push({
          ruleId: "CPI-EXC-003",
          message: `"${spName}" in "${name}" catches errors and ends normally without any handling step.`,
          line: lineFor(sp),
          element: spElement,
        });
      } else if (hasSteps(sp) && children(sp, "endEvent").length > 0 && !endsWithError(sp)) {
        findings.push({
          ruleId: "CPI-EXC-005",
          message: `"${spName}" in "${name}" ends with a Message End event; failed messages show as Completed.`,
          line: lineFor(sp),
          element: spElement,
        });
      }
    }

    collectScripts(process, name, false, scripts);
  }

  // ── secrets in step / adapter properties ──────────────────────────────
  walk(definitions, (node, tag) => {
    for (const p of props(node)) {
      const activity = prop(node, "activityType");
      const adapter = prop(node, "ComponentType");
      const type = activity ? (STEP_TYPES[activity] ?? activity) : adapter ? `${adapter} adapter` : tag;
      const element = elementOf(node, type);
      const line = lineFor(p.node) ?? lineFor(node);
      const secretLine = (secret: string) => lineForSecret(p.node, secret) ?? line;

      if (p.key === "headerTable" || p.key === "propertyTable") {
        for (const row of contentModifierRows(p.value)) {
          if (row.Action === "Delete" || row.Type !== "constant") continue;
          if (!isSecretName(row.Name ?? "") || !looksLikeSecretValue(row.Value ?? "")) continue;
          findings.push({
            ruleId: "CPI-CRED-005",
            message: `Content Modifier sets ${p.key === "headerTable" ? "header" : "property"} "${row.Name}" to a constant secret.`,
            line: secretLine(row.Value),
            element,
            secret: row.Value,
          });
        }
        continue;
      }

      if (p.key === "wrapContent" && p.value) {
        // Content Modifier body: look for credentials in the literal payload
        for (const hit of [...scanForSecretAssignments(p.value), ...scanXmlSecretElements(p.value)]) {
          findings.push({
            ruleId: "CPI-CRED-005",
            message: `Content Modifier message body: ${hit.message}`,
            line,
            element,
            secret: hit.secret,
          });
        }
        continue;
      }

      if (isSecretName(p.key) && looksLikeSecretValue(p.value) && !/^(true|false|\d+)$/i.test(p.value)) {
        findings.push({
          ruleId: "CPI-CRED-005",
          message: `Property "${p.key}" of ${type} "${element.name ?? element.id}" holds a literal value.`,
          line: secretLine(p.value),
          element,
          secret: p.value,
        });
      }
    }
  });

  // ── format-based secrets anywhere in the raw XML ──────────────────────
  for (const hit of scanForSecretPatterns(xml)) {
    findings.push({
      ruleId: hit.ruleId,
      message: hit.message,
      line: lineOf(lineStarts, hit.offset),
      secret: hit.secret,
      ...(hit.severity ? { severity: hit.severity } : {}),
    });
  }

  return { findings, scripts };
}

function walk(node: XNode, visit: (node: XNode, tag: string) => void, tag = "definitions") {
  visit(node, tag);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "extensionElements" || !Array.isArray(value)) continue;
    for (const child of value) if (typeof child === "object" && child !== null) walk(child as XNode, visit, key);
  }
}

function collectScripts(node: XNode, processName: string, inException: boolean, out: ScriptUsage[]) {
  for (const step of children(node, "callActivity")) {
    const script = prop(step, "script");
    if (prop(step, "activityType") === "Script" && script) {
      out.push({
        script,
        stepId: attr(step, "id") ?? "?",
        stepName: attr(step, "name"),
        processName,
        inExceptionSubprocess: inException,
      });
    }
  }
  for (const sp of children(node, "subProcess")) collectScripts(sp, processName, inException || isExceptionSubprocess(sp), out);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Content Modifier tables are stored as `<row><cell id='Name'>…</cell>…</row>` strings. */
export function contentModifierRows(table: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const r of decodeEntities(table).matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const row: Record<string, string> = {};
    for (const c of r[1].matchAll(/<cell\s+id=['"]([^'"]+)['"]\s*>([\s\S]*?)<\/cell>/g)) row[c[1]] = decodeEntities(c[2]);
    rows.push(row);
  }
  return rows;
}
