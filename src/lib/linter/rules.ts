import type { RuleMeta } from "./types";

export const RULES = [
  // ── Hardcoded credentials ────────────────────────────────────────────────
  {
    id: "CPI-CRED-001",
    title: "Hardcoded secret literal",
    category: "credentials",
    severity: "high",
    description:
      "A variable, map entry, header or element whose name suggests a secret (password, token, apiKey, clientSecret, ...) is assigned a literal value in a script or resource file. Anyone with access to the package, its Git history or a tenant export can read it.",
    recommendation:
      "Deploy the value as a User Credentials / Secure Parameter security material and read it at runtime via SecureStoreService (ITApiFactory.getService(SecureStoreService, null).getUserCredential(alias)). Rotate the exposed secret.",
  },
  {
    id: "CPI-CRED-002",
    title: "Literal Authorization header",
    category: "credentials",
    severity: "critical",
    description:
      "A complete `Basic <base64>` or `Bearer <token>` value is embedded in the package. Basic credentials are only base64-encoded, so the username and password are effectively plain text.",
    recommendation:
      "Use the adapter's Basic / OAuth2 authentication with a deployed credential instead of building the header by hand. If a script must build it, read the credential from the Secure Store. Rotate the exposed credential.",
  },
  {
    id: "CPI-CRED-003",
    title: "Embedded private key or provider token",
    category: "credentials",
    severity: "critical",
    description:
      "Content matching a well-known secret format was found: PEM private key, AWS access key, JWT, XSUAA client secret, GitHub/Slack/Stripe/Google token or Azure storage key.",
    recommendation:
      "Remove it from the package, store keys in the Keystore and tokens as Secure Parameters, and rotate the leaked secret immediately.",
  },
  {
    id: "CPI-CRED-004",
    title: "Credentials in URL",
    category: "credentials",
    severity: "high",
    description:
      "A URL contains inline user:password credentials or a secret-looking query parameter (api_key, token, password, sig, ...). URLs are logged by adapters, proxies and the message processing log.",
    recommendation:
      "Move the credential into the adapter's authentication settings, an Authorization header sourced from a Secure Parameter, or an externalized parameter backed by a credential.",
  },
  {
    id: "CPI-CRED-005",
    title: "Secret in iFlow step or adapter property",
    category: "credentials",
    severity: "high",
    description:
      "A Content Modifier header/property or an adapter field with a secret-looking name holds a constant value directly in the iFlow model (.iflw).",
    recommendation:
      "Reference a deployed credential alias (adapter Credential Name) or read the secret in a script from the Secure Store. Never set Authorization/password headers as Content Modifier constants.",
  },
  {
    id: "CPI-CRED-006",
    title: "Secret value in externalized parameters",
    category: "credentials",
    severity: "high",
    description:
      "parameters.prop ships the configured value of an externalized parameter whose name looks like a secret. These files travel with every export and transport.",
    recommendation:
      "Externalize the credential *alias* rather than the secret itself, and keep the secret in Security Material.",
  },

  // ── Exception handling ───────────────────────────────────────────────────
  {
    id: "CPI-EXC-001",
    title: "Integration process without exception subprocess",
    category: "exception-handling",
    severity: "high",
    description:
      "The integration process has no Exception Subprocess. Errors surface only as a generic failed MPL: no alerting, no compensation, no controlled response to the sender.",
    recommendation:
      "Add an Exception Subprocess (Error Start Event) that captures ${exception.message}, notifies/alerts, and ends with an Error or Escalation End event so monitoring reflects the failure.",
  },
  {
    id: "CPI-EXC-002",
    title: "Local integration process without exception subprocess",
    category: "exception-handling",
    severity: "low",
    description:
      "A Local Integration Process has no Exception Subprocess. Errors propagate to the caller, which is fine only if the calling process handles them and you don't need step-specific handling.",
    recommendation:
      "Add a local Exception Subprocess when this process needs its own cleanup, retry or error context; otherwise make sure the caller has one.",
  },
  {
    id: "CPI-EXC-003",
    title: "Exception subprocess swallows errors",
    category: "exception-handling",
    severity: "medium",
    description:
      "The Exception Subprocess goes straight from the Error Start Event to a normal End event without doing anything. Failures are silently converted into successful completions.",
    recommendation:
      "Log/alert inside the subprocess and end with an Error End or Escalation End event, or remove the empty subprocess so the error surfaces.",
  },
  {
    id: "CPI-EXC-004",
    title: "Empty catch block in script",
    category: "exception-handling",
    severity: "medium",
    description:
      "A script catches an exception and ignores it (empty block or bare return). The iFlow continues with partial data and the root cause never reaches the MPL.",
    recommendation:
      "Re-throw (optionally wrapped with context), or record the error on the message log and set a property the flow can route on.",
  },
  {
    id: "CPI-EXC-005",
    title: "Exception subprocess masks failure status",
    category: "exception-handling",
    severity: "info",
    description:
      "The Exception Subprocess handles the error but finishes with a Message End event only, so the message is reported as Completed in monitoring.",
    recommendation:
      "If the failure should be visible in monitoring and alerting, end with an Error End or Escalation End event.",
  },

  // ── Logging ──────────────────────────────────────────────────────────────
  {
    id: "CPI-LOG-001",
    title: "Unconditional message log attachment",
    category: "logging",
    severity: "medium",
    description:
      "messageLog.addAttachmentAsString(...) runs for every message, not behind a log-level property/header switch. Every execution writes an attachment to the MPL, filling tenant storage (MPL attachments count against the database quota) and exposing payload data.",
    recommendation:
      "Guard payload logging with a flag (e.g. an externalized parameter copied to a property such as `enablePayloadLogging`) and only enable it while troubleshooting.",
  },
  {
    id: "CPI-LOG-002",
    title: "Message log attachment inside a loop",
    category: "logging",
    severity: "high",
    description:
      "An MPL attachment is written inside a loop or iteration closure, so the number of attachments grows with the payload. Large batches can produce thousands of attachments per message.",
    recommendation:
      "Aggregate what you need and write a single (size-capped) attachment after the loop, behind a logging flag.",
  },
  {
    id: "CPI-LOG-003",
    title: "Payload written to MPL property",
    category: "logging",
    severity: "medium",
    description:
      "The message body is written into a custom header property or string property of the message log. These are meant for short searchable values and are stored and indexed for every message.",
    recommendation:
      "Log only identifiers (order number, IDoc number, correlation id) as custom header properties; use a guarded attachment for payloads.",
  },
  {
    id: "CPI-LOG-004",
    title: "Logging to stdout",
    category: "logging",
    severity: "low",
    description:
      "println / System.out / printStackTrace write to the worker's system log, which is unbounded, not correlated with the message and not visible in message monitoring.",
    recommendation: "Use the MessageLog API (messageLogFactory.getMessageLog(message)) or throw the exception.",
  },
  {
    id: "CPI-LOG-005",
    title: "Payload attachment without size cap",
    category: "logging",
    severity: "low",
    description:
      "A guarded payload attachment writes the whole body. When logging is switched on in production a single large message can produce a multi-MB attachment.",
    recommendation: "Truncate before logging, e.g. body.take(100_000), and note the original size in the attachment name.",
  },

  // ── Risky Groovy ─────────────────────────────────────────────────────────
  {
    id: "CPI-GRV-001",
    title: "Payload materialized as String / byte[]",
    category: "groovy",
    severity: "medium",
    description:
      "message.getBody(String) (or byte[]) copies the entire payload into heap memory, usually several times over (UTF-16 String + intermediate buffers). Large payloads cause OutOfMemoryError and affect every iFlow on the worker.",
    recommendation:
      "Read the body as a stream: message.getBody(java.io.Reader) / getBody(InputStream) and process it incrementally (XmlSlurper.parse(reader), StAX, JsonSlurper.parse(reader), line-by-line).",
  },
  {
    id: "CPI-GRV-002",
    title: "Stream fully read into memory",
    category: "groovy",
    severity: "medium",
    description:
      "A Reader/InputStream body is read with .text, readLines(), readAllBytes() or IOUtils.toString(), which defeats streaming and has the same memory profile as getBody(String).",
    recommendation: "Consume the stream incrementally (eachLine, a streaming parser, or copy stream-to-stream).",
  },
  {
    id: "CPI-GRV-003",
    title: "Whole payload parsed into an in-memory tree",
    category: "groovy",
    severity: "medium",
    description:
      "parseText() on XmlSlurper / XmlParser / JsonSlurper (or a DOM DocumentBuilder) requires the full payload as a String and builds a complete object tree — typically 5–10x the payload size in heap.",
    recommendation:
      "Parse from a Reader (new XmlSlurper().parse(message.getBody(Reader))), use StAX for very large XML, or do the work in a Message Mapping / XSLT step.",
  },
  {
    id: "CPI-GRV-004",
    title: "Dynamic code or process execution",
    category: "groovy",
    severity: "high",
    description:
      "Eval / GroovyShell / ScriptEngine / evaluate() or OS process execution (\"cmd\".execute(), Runtime.exec, ProcessBuilder) can run arbitrary code built from message content and is not supported on the multi-tenant runtime.",
    recommendation: "Replace with explicit logic. Never evaluate strings that come from message content.",
  },
  {
    id: "CPI-GRV-005",
    title: "TLS certificate / hostname verification disabled",
    category: "groovy",
    severity: "high",
    description:
      "A trust-all TrustManager or permissive HostnameVerifier disables TLS verification, enabling man-in-the-middle attacks on the outbound call.",
    recommendation:
      "Use a receiver adapter (which honours the tenant keystore) or import the server's CA into the Keystore instead of disabling verification.",
  },
  {
    id: "CPI-GRV-006",
    title: "Thread.sleep in script",
    category: "groovy",
    severity: "low",
    description:
      "Sleeping blocks a worker thread (and the message's transaction) for the whole duration, reducing throughput for every iFlow on the node.",
    recommendation: "Use adapter retry settings, a JMS retry pattern, or a Timer-based polling iFlow instead of sleeping.",
  },
  {
    id: "CPI-GRV-007",
    title: "System.exit / Runtime.halt",
    category: "groovy",
    severity: "high",
    description: "Attempts to terminate the JVM that hosts every integration flow on the worker.",
    recommendation: "Throw an exception to fail the message instead.",
  },
  {
    id: "CPI-GRV-008",
    title: "String concatenation in loop",
    category: "groovy",
    severity: "low",
    description:
      "Building a String with += inside a loop copies the accumulated text on every iteration (O(n²)) and spikes memory on large payloads.",
    recommendation: "Use a StringBuilder, or better, write to a Writer / output stream.",
  },
  {
    id: "CPI-GRV-009",
    title: "Payload copied into exchange property/header",
    category: "groovy",
    severity: "low",
    description:
      "The full body String is stored in a property or header. Properties live for the whole exchange (and headers may be sent to receivers), so the payload stays in memory at least twice.",
    recommendation: "Store only the values you need later, or persist the payload with a Data Store / Persist step.",
  },
  {
    id: "CPI-GRV-010",
    title: "Local file system access",
    category: "groovy",
    severity: "low",
    description:
      "Worker file systems are ephemeral and not shared between nodes; files written here disappear on restart and are invisible to other workers.",
    recommendation: "Use Data Store, Message Store, JMS queues or an SFTP/Object Store receiver for persistence.",
  },
] as const satisfies readonly RuleMeta[];

export type RuleId = (typeof RULES)[number]["id"];

export const RULE_BY_ID: Record<RuleId, RuleMeta> = Object.fromEntries(RULES.map((r) => [r.id, r])) as Record<
  RuleId,
  RuleMeta
>;
