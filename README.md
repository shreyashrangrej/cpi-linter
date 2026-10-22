# cpi-linter

Static analysis for SAP Cloud Integration (CPI) packages. You upload an exported integration package and it flags:

- **Hardcoded credentials**: password/token literals in Groovy or JS, literal `Basic`/`Bearer` headers (Basic values are decoded to show the user), PEM keys, JWTs, XSUAA client secrets, AWS/GitHub/Slack/Google keys, credentials in URLs, constant secret headers in Content Modifiers, literal adapter secrets and secrets in `parameters.prop`.
- **Exception handling**: integration processes without an Exception Subprocess, subprocesses that swallow errors (Error Start → normal End with no steps), subprocesses that mark failures as *Completed*, and empty `catch` blocks.
- **Unbounded logging**: `addAttachmentAsString` that isn't behind a logging switch, attachments written inside loops, payloads written to MPL properties, uncapped payload attachments, and `println`/`printStackTrace`.
- **Risky Groovy**: `getBody(String)`/`byte[]`, Reader/InputStream read in full (`.text`, `readLines`, `IOUtils.toString`), `parseText()`/DOM parsing, the payload copied into properties, `+=` string building in loops, `Eval`/`GroovyShell`/`.execute()`, trust-all TLS, `Thread.sleep`, `System.exit` and local file I/O.

The full list of 26 rules, with an explanation and fix for each, is at `/rules`.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # vitest
npm run build
```

Analysis in the web UI runs **entirely in the browser**, so a package with real credentials never leaves the machine. Use **Try the demo package** to see a deliberately flawed sample package (`src/lib/sample/package.ts`, all credentials fake).

### CLI (CI pipelines)

```bash
npm run cpi-lint -- MyPackage.zip                         # human-readable
npm run cpi-lint -- MyPackage.zip --format sarif --output cpi.sarif
npm run cpi-lint -- a.zip b.zip --fail-on medium          # exit 1 if any finding >= medium
npm run cpi-lint -- --sample                              # lint the demo package
```

Formats: `text` (default), `json`, `sarif`, `md`. `--fail-on` takes `critical|high|medium|low|info|never` (default `high`). SARIF output can go straight into GitHub code scanning or Azure DevOps.

### HTTP API

```bash
curl -F file=@MyPackage.zip "http://localhost:3000/api/lint"                 # JSON report
curl --data-binary @MyPackage.zip "http://localhost:3000/api/lint?name=MyPackage.zip&format=sarif"
```

Uploads are capped at 50 MB.

## Supported inputs

- **Integration package export** (`resources.cnt` plus `<id>_content` artifact zips). Artifact names and types come from `resources.cnt` and each artifact's `MANIFEST.MF`.
- **Single artifact export** (iFlow or script collection `.zip`).
- A zip of several exports, or a loose `.iflw` / `.groovy` / `.js` / `parameters.prop` file.

Nested archives are limited by depth, entry count and total expanded size, which guards against zip bombs.

## Suppressing findings

```groovy
// cpilint-disable-file CPI-GRV-001
def body = message.getBody(String) // cpilint-disable-line CPI-GRV-001
// cpilint-disable-next-line CPI-LOG-001 CPI-LOG-005
messageLog.addAttachmentAsString("Payload", body, "text/plain")
```

If you leave out the rule IDs, the comment suppresses every rule.

## How it works

`src/lib/linter/` has no framework dependencies, so the browser, the API route and the CLI all share it:

| File | Purpose |
| --- | --- |
| `archive.ts` | Unpacks package, artifact and loose-file layouts with JSZip |
| `checks/iflow.ts` | Parses BPMN (`fast-xml-parser`) for process structure, Content Modifier tables, adapter properties and script-step wiring |
| `checks/script.ts` | Groovy/JS checks over a comment- and string-aware view of the source; works out loops and logging guards from block structure (braced/inline `if`, early return, guarded helper methods) |
| `checks/resources.ts` | `parameters.prop`, JSON and XML resources |
| `secrets.ts` | Secret-name heuristics, value checks and token formats |
| `engine.ts` | Dispatches files to the checks, applies suppressions, de-duplicates, masks secrets in snippets and sorts results |
| `rules.ts` | Rule metadata (severity, description, fix) |

Findings use context across files. For example, a logging script that only runs inside an Exception Subprocess is downgraded to *low*, and logging findings name the iFlow step that calls the script. Secret values never appear in reports: snippets are masked (`Basic b3J••••••••••`).

The checks are heuristics, not a Groovy compiler. Expect some false positives and suppress them with the comments above.
