import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildSamplePackage } from "../sample/package";
import { contentModifierTable, iflw, scriptStep } from "../sample/iflw";
import { lintFiles, lintPackage, toSarif } from ".";
import type { Finding, SourceFile } from "./types";

const artifact = { id: "A1", name: "Test Flow", type: "IFlow" };
const file = (path: string, text: string): SourceFile => ({ artifact, path, text });
const lintScript = (text: string) => lintFiles([file("src/main/resources/script/s.groovy", text)]);
const ids = (fs: Finding[]) => fs.map((f) => f.ruleId).sort();

const wrap = (body: string) => `import com.sap.gateway.ip.core.customdev.util.Message
def Message processData(Message message) {
${body}
    return message
}
`;

describe("hardcoded credentials", () => {
  it("flags secret-named variables assigned literals", () => {
    const fs = lintScript(wrap(`    def password = "hunter22"\n    String clientSecret = 'abc123xyz'`));
    expect(ids(fs)).toEqual(["CPI-CRED-001", "CPI-CRED-001"]);
    expect(fs[0].snippet).not.toContain("hunter22");
  });

  it("ignores aliases, lookups, placeholders and key names", () => {
    const fs = lintScript(
      wrap(`
    def passwordAlias = "SFTP_PASSWORD"
    def tokenUrl = "https://auth.example.com/oauth/token"
    def password = message.getProperty("password")
    def secret = "\${props.secret}"
    def token = ""
    def PASSWORD_KEY = "password"
    def credentialName = "MY_CRED"
    if (pwd == "abc") {}
`),
    );
    expect(fs.filter((f) => f.category === "credentials")).toEqual([]);
  });

  it("decodes literal Basic auth headers", () => {
    const basic = btoa("svc_user:Sup3rSecret!");
    const fs = lintScript(wrap(`    message.setHeader("Authorization", "Basic ${basic}")`));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ ruleId: "CPI-CRED-002", severity: "critical" });
    expect(fs[0].message).toContain('"svc_user"');
    expect(fs[0].snippet).toContain("Basic ");
    expect(fs[0].snippet).not.toContain(basic);
  });

  it("does not treat prose like 'Basic authentication' as a header", () => {
    expect(lintScript(`// Uses Basic authentication via the adapter\n`)).toEqual([]);
  });

  it("detects provider tokens and private keys anywhere", () => {
    const fs = lintFiles([
      file("key.txt", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n"),
      file("cfg.json", `{ "aws": "AKIAIOSFODNN7EXAMPLE" }`),
    ]);
    expect(ids(fs)).toEqual(["CPI-CRED-003", "CPI-CRED-003"]);
  });

  it("flags credentials in URLs", () => {
    const fs = lintScript(wrap(`    def u = "https://bob:p4ssw0rd@host.example.com/x?api_key=abcdef123456"`));
    expect(ids(fs)).toEqual(["CPI-CRED-004", "CPI-CRED-004"]);
  });

  it("flags secrets in parameters.prop but not aliases", () => {
    const fs = lintFiles([file("src/main/resources/parameters.prop", "SFTP_Password=Pa55\\!word\nSFTP_Credential_Name=SFTP_USER\nHost=x\n")]);
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ ruleId: "CPI-CRED-006", line: 1 });
  });
});

describe("iFlow exception handling", () => {
  const steps = [scriptStep("CallActivity_1", "Map", "map.groovy")];

  it("flags main and local processes without exception subprocess", () => {
    const xml = iflw({
      messageFlows: [],
      processes: [
        { id: "Process_1", name: "Integration Process", steps },
        { id: "Process_2", name: "Local Integration Process 1", props: { processType: "directCall" }, steps },
      ],
    });
    const fs = lintFiles([file("flow.iflw", xml)]);
    expect(ids(fs)).toEqual(["CPI-EXC-001", "CPI-EXC-002"]);
    expect(fs.find((f) => f.ruleId === "CPI-EXC-001")?.element?.id).toBe("Process_1");
  });

  it("flags an empty exception subprocess that ends normally", () => {
    const xml = iflw({
      messageFlows: [],
      processes: [{ id: "P", name: "Integration Process", steps, exceptionSubprocess: { id: "SP", name: "ESP", steps: [], end: "message" } }],
    });
    expect(ids(lintFiles([file("flow.iflw", xml)]))).toEqual(["CPI-EXC-003"]);
  });

  it("accepts an empty subprocess that re-throws via Error End", () => {
    const xml = iflw({
      messageFlows: [],
      processes: [{ id: "P", name: "Integration Process", steps, exceptionSubprocess: { id: "SP", name: "ESP", steps: [], end: "error" } }],
    });
    expect(lintFiles([file("flow.iflw", xml)])).toEqual([]);
  });

  it("notes subprocesses that mark failed messages as Completed", () => {
    const xml = iflw({
      messageFlows: [],
      processes: [
        { id: "P", name: "Integration Process", steps, exceptionSubprocess: { id: "SP", name: "ESP", steps: [scriptStep("E", "Alert", "alert.groovy")], end: "message" } },
      ],
    });
    expect(lintFiles([file("flow.iflw", xml)])).toMatchObject([{ ruleId: "CPI-EXC-005", severity: "info" }]);
  });
});

describe("iFlow credentials", () => {
  it("flags constant secret headers in Content Modifier, not expressions", () => {
    const xml = iflw({
      messageFlows: [],
      processes: [
        {
          id: "P",
          name: "Integration Process",
          exceptionSubprocess: { id: "SP", name: "ESP", steps: [], end: "error" },
          steps: [
            {
              id: "CM",
              name: "Headers",
              props: {
                activityType: "Enricher",
                headerTable: contentModifierTable([
                  { name: "apikey", type: "constant", value: "k_9a8b7c6d5e" },
                  { name: "Authorization", type: "expression", value: "${property.token}" },
                  { name: "password", type: "constant", value: "x", action: "Delete" },
                ]),
              },
            },
          ],
        },
      ],
    });
    const fs = lintFiles([file("flow.iflw", xml)]);
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ ruleId: "CPI-CRED-005", element: { id: "CM", name: "Headers" } });
    expect(fs[0].snippet).not.toContain("k_9a8b7c6d5e");
  });

  it("ignores credential aliases on adapters", () => {
    const xml = iflw({
      processes: [{ id: "P", name: "Integration Process", steps: [], exceptionSubprocess: { id: "SP", name: "ESP", steps: [], end: "error" } }],
      messageFlows: [
        {
          id: "MF",
          name: "HTTP",
          source: "a",
          target: "b",
          props: { ComponentType: "HTTP", authenticationMethod: "Basic", credentialName: "S4_TECH_USER", privateKeyAlias: "my_key", address: "https://{{host}}/api" },
        },
      ],
    });
    expect(lintFiles([file("flow.iflw", xml)])).toEqual([]);
  });
});

describe("logging", () => {
  it("flags unconditional payload attachments", () => {
    const fs = lintScript(
      wrap(`    def body = message.getBody(java.lang.String)
    def messageLog = messageLogFactory.getMessageLog(message)
    if (messageLog != null) {
        messageLog.addAttachmentAsString("Payload", body, "text/plain")
    }`),
    );
    expect(ids(fs)).toEqual(["CPI-GRV-001", "CPI-LOG-001"]);
  });

  it("accepts attachments behind a logging switch (braced, inline, early return, helper)", () => {
    const variants = [
      `    if (message.getProperty("ENABLE_LOGGING") == "true") {\n        messageLogFactory.getMessageLog(message).addAttachmentAsString("p", message.getBody(java.io.Reader).text.take(1000), "text/plain")\n    }`,
      `    def logOn = message.getProperty("log") == "true"\n    if (logOn) messageLogFactory.getMessageLog(message)?.addAttachmentAsString("p", "static", "text/plain")`,
      `    if (message.getProperty("debug") != "true") return message\n    messageLogFactory.getMessageLog(message).addAttachmentAsString("p", "x", "text/plain")`,
    ];
    for (const v of variants) {
      expect(lintScript(wrap(v)).filter((f) => f.category === "logging"), v).toEqual([]);
    }

    const helper = `def Message processData(Message message) {
    if (message.getProperty("TRACE") == "on") {
        logIt(message, "x")
    }
    return message
}
def logIt(Message message, String s) {
    messageLogFactory.getMessageLog(message).addAttachmentAsString("p", s, "text/plain")
}`;
    expect(lintScript(helper)).toEqual([]);
  });

  it("escalates attachments inside loops", () => {
    const fs = lintScript(wrap(`    def ml = messageLogFactory.getMessageLog(message)\n    items.each { item ->\n        ml.addAttachmentAsString("i", item.toString(), "text/plain")\n    }`));
    expect(fs).toMatchObject([{ ruleId: "CPI-LOG-002", severity: "high" }]);
  });

  it("flags guarded but uncapped payload attachments", () => {
    const fs = lintScript(wrap(`    if (message.getProperty("log") == "true") {\n        messageLogFactory.getMessageLog(message).addAttachmentAsString("p", message.getBody(String), "text/plain")\n    }`));
    expect(ids(fs)).toEqual(["CPI-GRV-001", "CPI-LOG-005"]);
  });

  it("flags payload in MPL properties but not string literals mentioning payload", () => {
    const fs = lintScript(
      wrap(`    def ml = messageLogFactory.getMessageLog(message)\n    ml.setStringProperty("info", "Payload received")\n    ml.addCustomHeaderProperty("body", message.getBody(String))`),
    );
    expect(ids(fs)).toEqual(["CPI-GRV-001", "CPI-LOG-003"]);
  });

  it("flags println and printStackTrace", () => {
    expect(ids(lintScript(wrap(`    println "hi"\n    try { x() } catch (e) { e.printStackTrace() }`)))).toEqual(["CPI-LOG-004", "CPI-LOG-004"]);
  });
});

describe("risky Groovy", () => {
  it("flags reading the body as String, bytes and full stream reads", () => {
    const fs = lintScript(
      wrap(`    def a = message.getBody(String)
    def b = message.getBody(byte[])
    def r = message.getBody(java.io.Reader)
    def c = r.text
    def d = message.getBody(java.io.InputStream).getText("UTF-8")
    def e = IOUtils.toString(message.getBody(InputStream))`),
    );
    expect(ids(fs)).toEqual(["CPI-GRV-001", "CPI-GRV-001", "CPI-GRV-002", "CPI-GRV-002", "CPI-GRV-002"]);
  });

  it("accepts streaming parsing", () => {
    expect(lintScript(wrap(`    def xml = new XmlSlurper().parse(message.getBody(java.io.Reader))\n    message.setBody(xml.Id.text())`))).toEqual([]);
  });

  it("flags parseText, dynamic code, sleep, exit and file access", () => {
    const fs = lintScript(
      wrap(`    def x = new JsonSlurper().parseText(s)
    Eval.me(s)
    "ls".execute()
    Thread.sleep(100)
    System.exit(1)
    new File("/tmp/x").text = "y"`),
    );
    expect(ids(fs)).toEqual(["CPI-GRV-003", "CPI-GRV-004", "CPI-GRV-004", "CPI-GRV-006", "CPI-GRV-007", "CPI-GRV-010"]);
  });

  it("flags empty catch blocks", () => {
    expect(ids(lintScript(wrap(`    try { risky() } catch (Exception e) { /* ignore */ }`)))).toEqual(["CPI-EXC-004"]);
  });

  it("ignores patterns inside comments and strings", () => {
    expect(lintScript(wrap(`    // message.getBody(String)\n    def s = "Thread.sleep(1) System.exit(0)"\n    /* Eval.me(x) */`))).toEqual([]);
  });

  it("flags string += in loops only", () => {
    const fs = lintScript(wrap(`    String out = ""\n    out += "header"\n    for (i in list) {\n        out += i\n    }`));
    expect(fs).toMatchObject([{ ruleId: "CPI-GRV-008", line: 6 }]);
  });
});

describe("suppressions", () => {
  it("honours line, next-line and file directives", () => {
    const text = wrap(`    Thread.sleep(1) // cpilint-disable-line CPI-GRV-006
    // cpilint-disable-next-line
    def x = message.getBody(String)
    def y = message.getBody(String)`);
    expect(lintScript(text)).toMatchObject([{ ruleId: "CPI-GRV-001", line: 6 }]);
    expect(lintScript("// cpilint-disable-file CPI-GRV-001\n" + text)).toEqual([]);
  });
});

describe("package handling", () => {
  it("lints the sample package export end-to-end", async () => {
    const bytes = await buildSamplePackage();
    const report = await lintPackage(bytes, "sample.zip");

    expect(report.package?.name).toBe("Demo – Order Integrations");
    expect(report.artifacts.map((a) => [a.name, a.type])).toEqual([
      ["Order Replication to S/4HANA", "IFlow"],
      ["Customer Master Sync (C4C)", "IFlow"],
      ["Shared HTTP Utilities", "ScriptCollection"],
    ]);
    expect(report.warnings).toEqual([]);
    for (const cat of ["credentials", "exception-handling", "logging", "groovy"] as const) {
      expect(report.summary.byCategory[cat]).toBeGreaterThan(0);
    }
    // the well-built flow only has the (downgraded) error-logging finding
    const customer = report.findings.filter((f) => f.artifact.name.startsWith("Customer"));
    expect(customer).toMatchObject([{ ruleId: "CPI-LOG-001", severity: "low" }]);

    // no secret value leaks into the report
    const json = JSON.stringify(report);
    for (const secret of ["Welcome@123", "Pa55w0rd", "Sup3rS3cret", "b3JkZXJzX2FwaTpTM2NyZXQhMjAyNA", "ak_live_7Hq2Lr9WvX4mZ8pN", "Pr0xy#Secret"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("lints a single iFlow export and loose files", async () => {
    const zip = new JSZip();
    zip.file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nBundle-Name: My Flow\r\nSAP-BundleType: IntegrationFlow\r\n");
    zip.file("src/main/resources/script/a.groovy", "def x = message.getBody(String)\n");
    const report = await lintPackage(await zip.generateAsync({ type: "uint8array" }), "My_Flow.zip");
    expect(report.artifacts).toMatchObject([{ name: "My Flow", type: "IFlow", scripts: 1 }]);
    expect(ids(report.findings)).toEqual(["CPI-GRV-001"]);

    const loose = await lintPackage(new TextEncoder().encode("def x = message.getBody(String)\n"), "x.groovy");
    expect(ids(loose.findings)).toEqual(["CPI-GRV-001"]);
  });

  it("rejects unsupported files", async () => {
    await expect(lintPackage(new Uint8Array([1, 2, 3, 0, 0]), "image.png")).rejects.toThrow(/Unsupported/);
  });

  it("produces valid-looking SARIF", async () => {
    const report = await lintPackage(await buildSamplePackage(), "sample.zip");
    const sarif = toSarif(report);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toHaveLength(report.findings.length);
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region?.startLine).toBeGreaterThan(0);
  });
});
