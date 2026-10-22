import type { RuleId } from "../rules";
import { scanForSecretAssignments, scanForSecretPatterns } from "../secrets";
import { type LexedSource, enclosingBlocks, lex, position } from "../source";
import type { Severity } from "../types";
import type { RawFinding } from "./common";

const LOOP_HEADER =
  /(?:^|[^\w.])(?:for|while)\s*\(|^do$|\.\s*(?:each\w*|forEach|collect\w*|times|upto|downto|step|findAll|find|any|every|inject|sum|groupBy|split)\s*(?:\([^)]*\))?\s*$/;
const METHOD_HEADER = /^(?:(?:public|private|protected|static|final|def|function|[\w.<>[\]]+)\s+)+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?$/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "else", "try", "do"]);

/** Method name if the block header is a method/function declaration. */
function methodName(header: string): string | null {
  if (/^(?:}\s*)?(?:else|if|for|while|catch|return|switch)\b/.test(header)) return null;
  const name = header.match(METHOD_HEADER)?.[1];
  return name && !KEYWORDS.has(name) ? name : null;
}
const IF_HEADER = /^(?:}\s*)?(?:else\s+)?if\s*\(([\s\S]*)\)$/;
const SIZE_CAP = /\.take\s*\(|substring\s*\(|\b(?:length|size)\s*\(?\s*\)?\s*[<>]=?|truncat|abbreviate/i;

const STRING_BODY =
  /\.getBody\s*\(\s*(?:(?:java\.lang\.)?String(?:\.class)?|new\s+java\.lang\.String\s*\(\s*\)\s*\.getClass\s*\(\s*\))\s*\)|\.getBody\s*\(\s*\)\s*as\s+String\b|\(\s*String\s*\)\s*\w+\s*\.\s*getBody\s*\(\s*\)/g;
const BYTES_BODY = /\.getBody\s*\(\s*(?:byte\s*\[\s*\]|\[B)(?:\.class)?\s*\)/g;
const STREAM_BODY = /\.getBody\s*\(\s*(?:java\.io\.)?(?:Reader|InputStream)(?:\.class)?\s*\)/;
const FULL_READ = String.raw`\s*\.\s*(?:text\b|getText\s*\(|readLines\s*\(|readAllBytes\s*\(|bytes\b|getBytes\s*\()`;

interface Ctx {
  src: LexedSource;
  out: RawFinding[];
  stringBodyVars: string[];
  streamBodyVars: string[];
}

export function checkScript(text: string): RawFinding[] {
  const src = lex(text);
  const ctx: Ctx = { src, out: [], ...bodyVariables(src) };

  checkCredentials(ctx);
  checkMemory(ctx);
  checkLogging(ctx);
  checkMisc(ctx);
  return ctx.out;
}

function add(ctx: Ctx, ruleId: RuleId, offset: number, message: string, extra: Partial<RawFinding> = {}) {
  ctx.out.push({ ruleId, message, ...position(ctx.src, offset), ...extra });
}

function matchAll(ctx: Ctx, re: RegExp, ruleId: RuleId, message: string | ((m: RegExpExecArray) => string), severity?: Severity) {
  const g = re.global ? re : new RegExp(re.source, re.flags + "g");
  for (const m of ctx.src.code.matchAll(g)) {
    add(ctx, ruleId, m.index, typeof message === "string" ? message : message(m), severity ? { severity } : {});
  }
}

function bodyVariables(src: LexedSource) {
  const stringBodyVars: string[] = [];
  const streamBodyVars: string[] = [];
  for (const m of src.code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*?\.getBody\s*\([^)]*\)(?:\s*as\s+String)?)/g)) {
    const rhs = m[2];
    if (STREAM_BODY.test(rhs)) streamBodyVars.push(m[1]);
    else if (new RegExp(STRING_BODY.source).test(rhs) || /\.getBody\s*\(\s*\)$/.test(rhs)) stringBodyVars.push(m[1]);
  }
  return { stringBodyVars, streamBodyVars };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function anyVar(names: string[]): string | null {
  return names.length ? `\\b(?:${names.map(escapeRe).join("|")})\\b` : null;
}

// ── credentials ───────────────────────────────────────────────────────────

function checkCredentials(ctx: Ctx) {
  // Secrets in comments are still leaked, so scan the raw text.
  for (const hit of [...scanForSecretPatterns(ctx.src.text), ...scanForSecretAssignments(ctx.src.text)]) {
    const commented = ctx.src.noComments[hit.offset] !== ctx.src.text[hit.offset];
    add(ctx, hit.ruleId, hit.offset, hit.message + (commented ? " (inside a comment — still shipped with the package)" : ""), {
      secret: hit.secret,
      ...(hit.severity ? { severity: hit.severity } : {}),
    });
  }
}

// ── memory / payload handling ─────────────────────────────────────────────

function checkMemory(ctx: Ctx) {
  matchAll(ctx, STRING_BODY, "CPI-GRV-001", "The entire payload is loaded into memory as a String.");
  matchAll(ctx, BYTES_BODY, "CPI-GRV-001", "The entire payload is loaded into memory as a byte array.");

  matchAll(
    ctx,
    new RegExp(STREAM_BODY.source + FULL_READ, "g"),
    "CPI-GRV-002",
    "The body is requested as a stream but then read completely into memory.",
  );
  const streams = anyVar(ctx.streamBodyVars);
  if (streams) {
    matchAll(ctx, new RegExp(streams + FULL_READ, "g"), "CPI-GRV-002", (m) => {
      const v = m[0].split(".")[0].trim();
      return `Stream variable "${v}" (the message body) is read completely into memory.`;
    });
  }
  matchAll(
    ctx,
    /\b(?:IOUtils|StreamUtils|IOGroovyMethods)\s*\.\s*(?:toString|toByteArray|readLines|copyToString|getText)\s*\(/g,
    "CPI-GRV-002",
    (m) => `${m[0].replace(/\s+/g, "").replace(/\($/, "")}() reads the whole stream into memory.`,
  );

  matchAll(ctx, /\.\s*parseText\s*\(/g, "CPI-GRV-003", (m) => {
    const before = ctx.src.code.slice(Math.max(0, m.index - 200), m.index);
    const parser = before.match(/(XmlSlurper|XmlParser|JsonSlurper\w*)(?![\s\S]*(?:XmlSlurper|XmlParser|JsonSlurper))/)?.[1];
    return `${parser ? parser + "." : ""}parseText() needs the full payload as a String and builds the whole document tree in memory.`;
  });
  matchAll(
    ctx,
    /\.\s*newDocumentBuilder\s*\(\s*\)/g,
    "CPI-GRV-003",
    "DOM DocumentBuilder loads the full XML document into memory.",
  );

  // payload copied into properties / headers
  const strings = anyVar(ctx.stringBodyVars);
  const payloadArg = `(?:${strings ? strings + "|" : ""}[\\w.]+\\.getBody\\s*\\(\\s*(?:(?:java\\.lang\\.)?String(?:\\.class)?)?\\s*\\)(?:\\s*as\\s+String)?)`;
  matchAll(
    ctx,
    new RegExp(String.raw`\.\s*(setProperty|setHeader)\s*\(\s*[^,()]+,\s*` + payloadArg + String.raw`\s*\)`, "g"),
    "CPI-GRV-009",
    (m) => `The full payload is stored via ${m[1]}(); it now lives in memory for the rest of the exchange.`,
  );
}

// ── logging ───────────────────────────────────────────────────────────────

function checkLogging(ctx: Ctx) {
  const { src } = ctx;
  const bodyRefs = [...ctx.stringBodyVars, ...ctx.streamBodyVars];
  const isPayload = (s: string) =>
    /getBody|\bbody\b|\bpayload\b/i.test(s) || bodyRefs.some((v) => new RegExp(`\\b${escapeRe(v)}\\b`).test(s));

  for (const m of src.code.matchAll(/\.\s*(addAttachment\w*)\s*\(/g)) {
    const callAt = m.index;
    const args = callArgs(src, callAt + m[0].length - 1);
    const payload = isPayload(args.map((a) => a.code).join(","));
    const guarded = isGuarded(src, callAt, 0);
    const inLoop = enclosingBlocks(src, callAt).some((b) => LOOP_HEADER.test(b.header));
    const what = payload ? "the message payload" : "an attachment";

    if (inLoop) {
      add(ctx, "CPI-LOG-002", callAt, `${m[1]}() writes ${what} once per loop iteration${guarded ? "" : ", for every message"}.`, {
        severity: guarded ? "medium" : "high",
      });
    } else if (!guarded) {
      add(ctx, "CPI-LOG-001", callAt, `${m[1]}() writes ${what} to the MPL for every message; it is not behind a logging switch.`);
    } else if (payload && !hasSizeCap(src, callAt, args)) {
      add(ctx, "CPI-LOG-005", callAt, `${m[1]}() logs the whole payload without truncation when logging is enabled.`);
    }
  }

  for (const m of src.code.matchAll(/\.\s*(setStringProperty|addCustomHeaderProperty)\s*\(/g)) {
    const args = callArgs(src, m.index + m[0].length - 1);
    if (args.length >= 2 && isPayload(args.slice(1).map((a) => a.code).join(","))) {
      add(ctx, "CPI-LOG-003", m.index, `${m[1]}() stores the message payload as an MPL property.`);
    }
  }

  matchAll(
    ctx,
    /(?<![\w.])println\b|\bSystem\s*\.\s*(?:out|err)\s*\.\s*print(?:ln|f)?\b|\.\s*printStackTrace\s*\(/g,
    "CPI-LOG-004",
    (m) => `${m[0].replace(/\s+/g, "").replace(/^\./, "").replace(/\($/, "()")} writes to the worker's system log, not the message processing log.`,
  );
}

/**
 * Arguments of a call whose `(` is at `openParen`, as code (string contents
 * blanked — use for identifier checks) and text (string literals intact).
 */
function callArgs(src: LexedSource, openParen: number): { code: string; text: string }[] {
  const args: { code: string; text: string }[] = [];
  const push = (from: number, to: number) => args.push({ code: src.code.slice(from, to).trim(), text: src.noComments.slice(from, to).trim() });
  let depth = 0;
  let start = openParen + 1;
  for (let i = openParen; i < src.code.length; i++) {
    const c = src.code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        push(start, i);
        break;
      }
    } else if (c === "," && depth === 1) {
      push(start, i);
      start = i + 1;
    }
  }
  return args.filter((a) => a.code);
}

function isLoggingCondition(cond: string): boolean {
  const c = cond.replace(/\bmessageLog\w*\b/g, "");
  return /log|debug|trace|verbose|enable|level|getProperty|getHeader|getProperties|getHeaders/i.test(c);
}

/** Whether the code at `offset` only runs behind a logging switch. */
function isGuarded(src: LexedSource, offset: number, depth: number): boolean {
  const blocks = enclosingBlocks(src, offset);

  // 1. braced if/else around the call
  for (const b of blocks) {
    const m = b.header.match(IF_HEADER);
    if (m && isLoggingCondition(m[1])) return true;
    if (/^(?:}\s*)?else$/.test(b.header)) return true;
  }

  // 2. single-statement if, same line or the line before:
  //    `if (enabled) messageLog.addAttachmentAsString(...)`
  const stmtStart = Math.max(src.code.lastIndexOf(";", offset), src.code.lastIndexOf("{", offset), src.code.lastIndexOf("}", offset));
  const lines = src.noComments.slice(stmtStart + 1, offset).split("\n");
  const sameLine = lines[lines.length - 1].match(/\bif\s*\((.*)\)\s*[\w.?()]*$/);
  const prevLine = lines.slice(0, -1).reverse().find((l) => l.trim())?.match(/^\s*(?:else\s+)?if\s*\((.*)\)\s*$/);
  for (const m of [sameLine, prevLine]) if (m && isLoggingCondition(m[1])) return true;

  // 3. early return earlier in the method: `if (!logEnabled) return message`
  const method = blocks.find((b) => methodName(b.header));
  const scopeStart = method ? method.open : 0;
  for (const m of src.noComments.slice(scopeStart, offset).matchAll(/\bif\s*\(([^\n]*)\)\s*\{?\s*return\b/g)) {
    if (isLoggingCondition(m[1])) return true;
  }

  // 4. helper method that is only ever called behind a guard
  if (method && depth < 2) {
    const name = methodName(method.header);
    if (name && name !== "processData") {
      const declAt = src.code.lastIndexOf(name, method.open);
      const calls = [...src.code.matchAll(new RegExp(`(?<![\\w.])${escapeRe(name)}\\s*\\(`, "g"))].filter(
        (c) => c.index !== declAt,
      );
      if (calls.length > 0 && calls.every((c) => isGuarded(src, c.index, depth + 1))) return true;
    }
  }
  return false;
}

function hasSizeCap(src: LexedSource, offset: number, args: { code: string }[]): boolean {
  if (args.some((a) => SIZE_CAP.test(a.code))) return true;
  if (enclosingBlocks(src, offset).some((b) => SIZE_CAP.test(b.header))) return true;
  const method = enclosingBlocks(src, offset).find((b) => methodName(b.header));
  return SIZE_CAP.test(src.noComments.slice(method ? method.open : 0, offset));
}

// ── misc risky patterns ───────────────────────────────────────────────────

function checkMisc(ctx: Ctx) {
  const { src } = ctx;

  matchAll(
    ctx,
    /\bcatch\s*\([^)]*\)\s*\{\s*(?:return(?:\s+(?:message|msg|null))?\s*;?\s*)?\}/g,
    "CPI-EXC-004",
    (m) => (/return/.test(m[0]) ? "Exception is caught and the script returns as if nothing happened." : "Exception is caught and silently ignored."),
  );

  const dynamic: [RegExp, string][] = [
    [/\bEval\s*\.\s*(?:me|x|xy|xyz)\s*\(/g, "Eval executes a string as Groovy code."],
    [/\bnew\s+GroovyShell\s*\(/g, "GroovyShell compiles and runs code at runtime."],
    [/(?<![\w.])evaluate\s*\(/g, "evaluate() runs a string as Groovy code."],
    [/\b(?:ScriptEngineManager|getEngineByName)\b/g, "A ScriptEngine evaluates code at runtime."],
    [/\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(/g, "Runtime.exec() starts an operating-system process."],
    [/\bnew\s+ProcessBuilder\s*\(/g, "ProcessBuilder starts an operating-system process."],
    [/["'\])]\s*\.\s*execute\s*\(\s*\)/g, "String/List.execute() starts an operating-system process."],
  ];
  for (const [re, msg] of dynamic) matchAll(ctx, re, "CPI-GRV-004", msg);

  const tls: [RegExp, string][] = [
    [
      // method form `void checkServerTrusted(...) {}` and map-coercion form `checkServerTrusted: { c, a -> }`
      /\bcheckServerTrusted\s*(?:\([^)]*\)\s*(?:throws[^{]*)?\{\s*\}|:\s*\{[^{}]*->\s*\})/g,
      "X509TrustManager.checkServerTrusted() is empty — every certificate is trusted.",
    ],
    [
      /\bHostnameVerifier\b[^;]{0,200}?(?:return\s+true\b|->\s*true\b)|\{[\w\s,]*->\s*true\s*\}\s*as\s+HostnameVerifier\b/g,
      "HostnameVerifier accepts every hostname.",
    ],
    [
      /\b(?:NoopHostnameVerifier|ALLOW_ALL_HOSTNAME_VERIFIER|TrustAllStrategy|TrustSelfSignedStrategy|InsecureTrustManagerFactory|trustAllCerts|TrustAllCerts)\b/g,
      "Certificate or hostname verification is disabled.",
    ],
  ];
  for (const [re, msg] of tls) matchAll(ctx, re, "CPI-GRV-005", msg);

  matchAll(
    ctx,
    /(?<![\w.])(?:Thread\s*\.\s*|TimeUnit\s*\.\s*\w+\s*\.\s*)?sleep\s*\(/g,
    "CPI-GRV-006",
    "Sleeping blocks a worker thread for the whole duration.",
  );
  matchAll(ctx, /\bSystem\s*\.\s*exit\s*\(|\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*(?:halt|exit)\s*\(/g, "CPI-GRV-007", "Attempts to terminate the runtime JVM.");

  matchAll(
    ctx,
    /\bnew\s+File(?:OutputStream|Writer|InputStream|Reader)?\s*\(|\bFiles\s*\.\s*(?:write\w*|readAll\w*|newBuffered\w+|createTemp\w+|copy|move|delete\w*)\s*\(|\bFile\s*\.\s*createTempFile\s*\(/g,
    "CPI-GRV-010",
    "Reads or writes the worker's local file system.",
  );

  // String += in loops, for variables initialised from a string literal
  const stringVars = new Set<string>();
  for (const m of src.code.matchAll(/\b(?:def|String|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*["']/g)) stringVars.add(m[1]);
  for (const v of ctx.stringBodyVars) stringVars.add(v);
  if (stringVars.size) {
    const re = new RegExp(`(?:${anyVar([...stringVars])})\\s*\\+=`, "g");
    const reported = new Set<string>();
    for (const m of src.code.matchAll(re)) {
      const loop = enclosingBlocks(src, m.index).find((b) => LOOP_HEADER.test(b.header));
      const name = m[0].replace(/\s*\+=$/, "");
      if (!loop || reported.has(name + loop.open)) continue;
      reported.add(name + loop.open);
      add(ctx, "CPI-GRV-008", m.index, `String "${name}" is rebuilt with += on every loop iteration.`);
    }
  }
}
