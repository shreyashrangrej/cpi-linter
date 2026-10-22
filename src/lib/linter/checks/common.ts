import type { RuleId } from "../rules";
import type { Finding, Severity } from "../types";

/** A finding before it is enriched with rule metadata and file attribution. */
export interface RawFinding {
  ruleId: RuleId;
  message: string;
  line?: number;
  column?: number;
  severity?: Severity;
  element?: Finding["element"];
  /** The secret value, used for masking and de-duplication. Never reported. */
  secret?: string;
}
