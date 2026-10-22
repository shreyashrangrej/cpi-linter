import type { RuleId } from "./rules";
import type { Severity } from "./types";

/** Words that, inside an identifier, suggest the value is a secret. */
const SECRET_WORDS = [
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "signingkey",
  "token",
  "authorization",
  "bearer",
];

/** Identifier endings that mean "this names/describes a secret" rather than "this is a secret". */
const DESCRIPTOR_SUFFIXES = [
  "alias",
  "name",
  "names",
  "header",
  "headers",
  "property",
  "prop",
  "param",
  "parameter",
  "field",
  "column",
  "url",
  "uri",
  "endpoint",
  "path",
  "location",
  "file",
  "filename",
  "type",
  "mode",
  "method",
  "format",
  "encoding",
  "length",
  "len",
  "size",
  "count",
  "expiry",
  "expires",
  "expiresin",
  "expiration",
  "timeout",
  "ttl",
  "lifetime",
  "validity",
  "label",
  "regex",
  "pattern",
  "policy",
  "scope",
  "granttype",
  "prefix",
  "xpath",
  "id",
  "ref",
  "reference",
  "enabled",
  "required",
  "template",
  "placeholder",
  "variable",
  "var",
  "store",
  "service",
  "credential",
  "credentials",
];

const DESCRIPTOR_PREFIXES = ["is", "has", "use", "enable", "allow", "show", "send", "include", "propagate", "get", "set"];

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function isSecretName(raw: string): boolean {
  const name = normalize(raw);
  if (!name || !SECRET_WORDS.some((w) => name.includes(w))) return false;
  if (DESCRIPTOR_SUFFIXES.some((s) => name.endsWith(s) && name !== s)) return false;
  // passwordKey / tokenKey name a map key; apiKey / secretKey are secrets
  if (name.endsWith("key") && /(password|passwd|pwd|token)key$/.test(name)) return false;
  if (DESCRIPTOR_PREFIXES.some((p) => raw.startsWith(p) && /[A-Z_]/.test(raw[p.length] ?? ""))) return false;
  return true;
}

const PLACEHOLDER_VALUES = new Set([
  "true",
  "false",
  "null",
  "none",
  "undefined",
  "basic",
  "bearer",
  "oauth",
  "oauth2",
  "clientcredentials",
  "changeme",
  "dummy",
  "test",
  "example",
  "todo",
  "tbd",
  "xxx",
  "na",
]);

/** Whether a literal looks like an actual secret rather than a placeholder, expression or key name. */
export function looksLikeSecretValue(raw: string): boolean {
  const v = raw.trim();
  if (v.length < 3) return false;
  if (v.includes("${") || v.includes("{{") || v.includes("$(")) return false;
  if (/^[*x•.#?-]+$/i.test(v)) return false;
  if (/^<.*>$/.test(v) || /^\[.*\]$/.test(v)) return false;
  if (/^(basic|bearer)\s*$/i.test(v)) return false;
  if (PLACEHOLDER_VALUES.has(normalize(v))) return false;
  // a value like "SAP_PASSWORD" or "client_secret" is a key/alias name, not the secret itself
  if (/^[A-Za-z_.-]+$/.test(v) && SECRET_WORDS.some((w) => normalize(v).includes(w))) return false;
  // dotted identifiers such as "my.credential.alias" or a header name
  if (/^[a-z]+(\.[a-z]+)+$/i.test(v)) return false;
  return true;
}

export function maskSecret(secret: string): string {
  const scheme = secret.match(/^\s*(Basic|Bearer)\s+/i);
  if (scheme) return scheme[1] + " " + maskSecret(secret.slice(scheme[0].length));
  const s = secret.trim();
  if (s.length <= 4) return "••••";
  const keep = s.length >= 12 ? 3 : 1;
  return s.slice(0, keep) + "•".repeat(Math.min(s.length - keep, 10));
}

export interface SecretHit {
  ruleId: RuleId;
  offset: number;
  secret: string;
  message: string;
  severity?: Severity;
}

interface TokenPattern {
  re: RegExp;
  label: string;
  severity?: Severity;
}

const TOKEN_PATTERNS: TokenPattern[] = [
  { re: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----/g, label: "PEM private key" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: "AWS access key id" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: "JSON Web Token", severity: "high" },
  {
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$[A-Za-z0-9_+/-]{20,}={0,2}/g,
    label: "SAP XSUAA client secret",
  },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, label: "GitHub token" },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, label: "Slack token" },
  { re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/g, label: "Stripe live key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "Google API key", severity: "high" },
  { re: /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/g, label: "Azure storage account key" },
];

const QUERY_SECRET_PARAMS =
  "api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|sig|signature|code";

function decodeBase64(s: string): string | null {
  try {
    return atob(s);
  } catch {
    return null;
  }
}

/**
 * Format-based secret detection that works on any text: provider tokens,
 * literal Authorization headers and credentials embedded in URLs.
 */
export function scanForSecretPatterns(text: string): SecretHit[] {
  const hits: SecretHit[] = [];

  for (const { re, label, severity } of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits.push({ ruleId: "CPI-CRED-003", offset: m.index, secret: m[0], message: `${label} embedded in file.`, severity });
    }
  }

  for (const m of text.matchAll(/\bBasic\s+([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/g)) {
    const decoded = decodeBase64(m[1]);
    if (!decoded || !/^[\x20-\x7e]+$/.test(decoded) || !decoded.includes(":")) continue;
    const user = decoded.slice(0, decoded.indexOf(":"));
    hits.push({
      ruleId: "CPI-CRED-002",
      offset: m.index,
      secret: m[1],
      message: `Literal Basic Authorization value decodes to user "${user}" and a plain-text password.`,
    });
  }

  for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g)) {
    if (!/\d/.test(m[1]) || !/[A-Za-z]/.test(m[1])) continue;
    hits.push({
      ruleId: "CPI-CRED-002",
      offset: m.index,
      secret: m[1],
      severity: "high",
      message: "Literal Bearer token embedded in file.",
    });
  }

  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/'"<>{}$]+):([^\s@/'"<>]+)@[^\s'"<>]/gi)) {
    const password = m[2];
    if (!looksLikeSecretValue(password) || password.startsWith("{") || password.startsWith("$")) continue;
    hits.push({
      ruleId: "CPI-CRED-004",
      offset: m.index,
      secret: password,
      message: `URL contains inline credentials for user "${decodeURIComponent(m[1])}".`,
    });
  }

  const queryRe = new RegExp(`(?:[?&;]|&amp;)(${QUERY_SECRET_PARAMS})=([^&\\s"'<>{}$#]{6,})`, "gi");
  for (const m of text.matchAll(queryRe)) {
    if (!looksLikeSecretValue(m[2])) continue;
    hits.push({
      ruleId: "CPI-CRED-004",
      offset: m.index,
      secret: m[2],
      message: `URL query parameter "${m[1]}" carries a literal secret.`,
    });
  }

  return hits;
}

const STR = String.raw`(['"])((?:\\.|(?!\2)[^\\\n])*)\2`;

/**
 * Name/value literal pairs in code-like text: `password = "x"`, `[apiKey: 'x']`,
 * `"client_secret": "x"`, `.setHeader("Authorization", "x")`.
 */
export function scanForSecretAssignments(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const add = (offset: number, name: string, value: string, how: string) => {
    if (!isSecretName(name) || !looksLikeSecretValue(value)) return;
    hits.push({ ruleId: "CPI-CRED-001", offset, secret: value, message: `${how} "${name}" is set to a hardcoded literal.` });
  };

  // identifier = "literal"
  const assign = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*=(?![=~])\s*` + STR, "g");
  for (const m of text.matchAll(assign)) add(m.index, m[1], m[3], "Variable");

  // key: "literal"  (Groovy map literals, JSON)
  const entry = new RegExp(String.raw`(['"]?)([A-Za-z_][\w.-]*)\1\s*:\s*` + STR.replace(/\\2/g, "\\3"), "g");
  for (const m of text.matchAll(entry)) {
    if (/\?\s*$/.test(text.slice(Math.max(0, m.index - 40), m.index))) continue; // ternary
    add(m.index, m[2], m[4], "Key");
  }

  // .put("name", "literal") and friends
  const call = new RegExp(
    String.raw`\.(put|setProperty|setHeader|setRequestProperty|addHeader|setAttribute|header|property)\s*\(\s*(['"])([^'"\n]+)\2\s*,\s*` +
      STR.replace(/\\2/g, "\\4"),
    "g",
  );
  for (const m of text.matchAll(call)) add(m.index, m[3], m[5], m[1] === "put" ? "Map entry" : "Header/property");

  return hits;
}

/** `<password>literal</password>` style elements in XML resources. */
export function scanXmlSecretElements(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const m of text.matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([^<]+)<\/\1>/g)) {
    const local = m[1].split(":").pop()!;
    if (!isSecretName(local) || !looksLikeSecretValue(m[2])) continue;
    hits.push({
      ruleId: "CPI-CRED-001",
      offset: m.index,
      secret: m[2].trim(),
      message: `XML element <${m[1]}> contains a hardcoded secret.`,
    });
  }
  return hits;
}
