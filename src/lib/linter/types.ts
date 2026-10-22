export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Category =
  | "credentials"
  | "exception-handling"
  | "logging"
  | "groovy";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "credentials", label: "Hardcoded credentials" },
  { id: "exception-handling", label: "Exception handling" },
  { id: "logging", label: "Logging" },
  { id: "groovy", label: "Risky Groovy" },
];

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  IFlow: "Integration Flow",
  ScriptCollection: "Script Collection",
  MessageMapping: "Message Mapping",
  ValueMapping: "Value Mapping",
  ODataService: "OData API",
  RESTAPIProvider: "REST API",
  SOAPAPIProvider: "SOAP API",
  IntegrationAdapter: "Integration Adapter",
  File: "File",
  Url: "URL",
  Unknown: "Artifact",
};

export const artifactTypeLabel = (type: string) => ARTIFACT_TYPE_LABELS[type] ?? type;

export interface RuleMeta {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  /** What the rule detects and why it matters. */
  description: string;
  /** How to fix it. */
  recommendation: string;
}

export interface ArtifactRef {
  id: string;
  name: string;
  /** IFlow, ScriptCollection, MessageMapping, ValueMapping, ... */
  type: string;
  version?: string;
}

export interface Finding {
  ruleId: string;
  title: string;
  category: Category;
  severity: Severity;
  message: string;
  recommendation: string;
  artifact: ArtifactRef;
  /** Path of the file inside the artifact. */
  file: string;
  line?: number;
  column?: number;
  /** Source line (secrets masked). */
  snippet?: string;
  /** BPMN element the finding relates to (iFlow findings only). */
  element?: { id: string; name?: string; type?: string };
}

export interface ArtifactSummary extends ArtifactRef {
  files: string[];
  iflows: number;
  scripts: number;
}

export interface LintReport {
  source: { fileName: string; size: number };
  package?: { id?: string; name?: string; version?: string; description?: string };
  artifacts: ArtifactSummary[];
  findings: Finding[];
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byCategory: Record<Category, number>;
    filesScanned: number;
  };
  warnings: string[];
  durationMs: number;
}

/** A text file extracted from the package, attributed to its artifact. */
export interface SourceFile {
  artifact: ArtifactRef;
  path: string;
  text: string;
}
