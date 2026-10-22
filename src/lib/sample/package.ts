import JSZip from "jszip";
import { contentModifierTable, iflw, scriptStep } from "./iflw";

/*
 * A deliberately flawed demo package. All credentials below are fake.
 */

const ORDER_IFLW = iflw({
  messageFlows: [
    {
      id: "MessageFlow_In",
      name: "HTTPS",
      source: "Participant_Sender",
      target: "StartEvent_Process_1",
      props: { ComponentType: "HTTPS", urlPath: "/orders/replicate", senderAuthType: "RoleBased", userRole: "ESBMessaging.send" },
    },
    {
      id: "MessageFlow_S4",
      name: "HTTP",
      source: "ServiceTask_Call",
      target: "Participant_Receiver",
      props: {
        ComponentType: "HTTP",
        address: "https://s4.example.com/sap/opu/odata/sap/API_SALES_ORDER_SRV?sap-client=100&api_key=9f8e7d6c5b4a3210ffee",
        httpMethod: "POST",
        authenticationMethod: "None",
        credentialName: "",
        httpRequestTimeout: "60000",
      },
    },
    {
      id: "MessageFlow_SFTP",
      name: "SFTP",
      source: "ServiceTask_Archive",
      target: "Participant_Receiver",
      props: {
        ComponentType: "SFTP",
        host: "{{SFTP_Host}}",
        authentication: "user_password",
        credential_name: "{{SFTP_User}}",
        proxyPassword: "Pr0xy#Secret",
      },
    },
  ],
  processes: [
    {
      id: "Process_1",
      name: "Integration Process",
      steps: [
        {
          id: "CallActivity_SetHeaders",
          name: "Set Auth Header",
          props: {
            activityType: "Enricher",
            componentVersion: "1.5",
            cmdVariantUri: "ctype::FlowstepVariant/cname::Enricher/version::1.5.1",
            bodyType: "expression",
            wrapContent: "",
            headerTable: contentModifierTable([
              { name: "Authorization", type: "constant", value: "Basic b3JkZXJzX2FwaTpTM2NyZXQhMjAyNA==" },
              { name: "Content-Type", type: "constant", value: "application/json" },
              { name: "x-api-key", type: "constant", value: "ak_live_7Hq2Lr9WvX4mZ8pN" },
            ]),
            propertyTable: contentModifierTable([{ name: "orderId", type: "xpath", value: "/Order/Id" }]),
          },
        },
        scriptStep("CallActivity_Log", "Log Incoming Payload", "logPayload.groovy"),
        scriptStep("CallActivity_Transform", "Transform Orders", "transformOrders.groovy"),
        {
          id: "CallActivity_Enrich",
          name: "Enrich Customer",
          props: { activityType: "ProcessCallElement", processId: "Process_2", componentVersion: "1.0" },
        },
        { id: "ServiceTask_Call", name: "Send to S/4HANA", tag: "serviceTask", props: { activityType: "ExternalCall", componentVersion: "1.0" } },
        { id: "ServiceTask_Archive", name: "Archive to SFTP", tag: "serviceTask", props: { activityType: "ExternalCall", componentVersion: "1.0" } },
      ],
    },
    {
      id: "Process_2",
      name: "Local Integration Process 1",
      props: { processType: "directCall" },
      steps: [scriptStep("CallActivity_Lookup", "Lookup Customer", "lookupCustomer.groovy")],
      exceptionSubprocess: { id: "SubProcess_1", name: "Exception Subprocess 1", steps: [], end: "message" },
    },
  ],
});

const LOG_PAYLOAD = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    def body = message.getBody(java.lang.String) as String
    def messageLog = messageLogFactory.getMessageLog(message)
    if (messageLog != null) {
        messageLog.setStringProperty("Logging#1", "Printing Payload As Attachment")
        messageLog.addAttachmentAsString("Incoming payload", body, "text/plain")
        messageLog.addCustomHeaderProperty("payload", body)
    }
    println "Received order payload: " + body
    return message
}
`;

const TRANSFORM_ORDERS = `import com.sap.gateway.ip.core.customdev.util.Message
import groovy.xml.XmlSlurper

def Message processData(Message message) {
    // TODO move to security material
    def password = "Welcome@123"
    def apiToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmRlcnMtc2VydmljZSIsImlhdCI6MTcwMDAwMDAwMH0.c2lnbmF0dXJlLW5vdC1yZWFs'

    String body = message.getBody(String)
    def orders = new XmlSlurper().parseText(body)
    def messageLog = messageLogFactory.getMessageLog(message)

    String csv = ""
    orders.Order.each { order ->
        csv += "\${order.Id},\${order.Customer},\${order.Amount}\\n"
        messageLog.addAttachmentAsString("Order \${order.Id}", order.toString(), "text/xml")
    }

    try {
        Thread.sleep(2000) // give S/4 time to catch up
    } catch (Exception e) {
    }

    message.setProperty("originalPayload", body)
    message.setHeader("Authorization", "Bearer " + apiToken)
    message.setBody(csv)
    return message
}
`;

const LOOKUP_CUSTOMER = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    def reader = message.getBody(java.io.Reader)
    def customer = new XmlSlurper().parse(reader)

    def enableLog = message.getProperty("ENABLE_PAYLOAD_LOGGING")
    if (enableLog == "true") {
        def messageLog = messageLogFactory.getMessageLog(message)
        messageLog?.addAttachmentAsString("Customer", customer.toString(), "text/xml")
    }
    message.setHeader("customerId", customer.Id.text())
    return message
}
`;

const ORDER_PARAMS = `#Externalized parameters
#Tue Oct 21 09:12:44 UTC 2026
SFTP_Host=sftp.partner.example.com
SFTP_User=ORDERS_SFTP
SFTP_Password=Pa55w0rd\\!2024
Receiver_Timeout=60000
`;

// ── Customer Master Sync: mostly well-built ─────────────────────────────

const CUSTOMER_IFLW = iflw({
  messageFlows: [
    {
      id: "MessageFlow_Timer",
      name: "OData",
      source: "ServiceTask_Fetch",
      target: "Participant_Receiver",
      props: {
        ComponentType: "HCIOData",
        address: "https://{{C4C_Host}}/sap/c4c/odata/v1/c4codataapi",
        authenticationMethod: "Basic",
        credentialName: "C4C_TECH_USER",
      },
    },
  ],
  processes: [
    {
      id: "Process_1",
      name: "Integration Process",
      steps: [
        { id: "ServiceTask_Fetch", name: "Fetch Customers", tag: "serviceTask", props: { activityType: "ExternalCall", componentVersion: "1.0" } },
        scriptStep("CallActivity_Map", "Map Customers", "mapCustomers.groovy"),
      ],
      exceptionSubprocess: {
        id: "SubProcess_Err",
        name: "Exception Subprocess",
        steps: [scriptStep("CallActivity_Err", "Log Error", "logError.groovy")],
        end: "error",
      },
    },
  ],
});

const MAP_CUSTOMERS = `import com.sap.gateway.ip.core.customdev.util.Message
import groovy.xml.XmlSlurper
import groovy.xml.StreamingMarkupBuilder

def Message processData(Message message) {
    def logEnabled = message.getProperty("SAP_IsPayloadLoggingEnabled") == "true"
    def input = new XmlSlurper().parse(message.getBody(java.io.Reader))

    def out = new StringWriter()
    out << new StreamingMarkupBuilder().bind {
        Customers { input.entry.each { e -> Customer(id: e.id.text(), name: e.name.text()) } }
    }
    message.setBody(out.toString())

    if (logEnabled) {
        messageLogFactory.getMessageLog(message)?.addAttachmentAsString("Mapped", out.toString().take(50_000), "text/xml")
    }
    return message
}
`;

const LOG_ERROR = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    def ex = message.getProperty("CamelExceptionCaught")
    def messageLog = messageLogFactory.getMessageLog(message)
    messageLog?.addAttachmentAsString("Error", ex?.getMessage() ?: "unknown error", "text/plain")
    return message
}
`;

// ── Shared script collection ────────────────────────────────────────────

const HTTP_UTIL = `import javax.net.ssl.*
import java.security.cert.X509Certificate

class HttpUtil {
    static final String CLIENT_SECRET = "8d3f1e2a-77c1-4b0e-9d1f-6a2b3c4d5e6f\$Xq9vT2pLmN8rW4sYz7KbHc1dEfGh="

    static void trustEverything() {
        def trustAll = [
            getAcceptedIssuers: { null },
            checkClientTrusted: { X509Certificate[] c, String a -> },
            checkServerTrusted: { X509Certificate[] c, String a -> }
        ] as X509TrustManager
        SSLContext ctx = SSLContext.getInstance("TLS")
        ctx.init(null, [trustAll] as TrustManager[], null)
        HttpsURLConnection.setDefaultSSLSocketFactory(ctx.socketFactory)
        HttpsURLConnection.setDefaultHostnameVerifier({ host, session -> true } as HostnameVerifier)
    }

    static String ping(String host) {
        return "ping -c 1 \${host}".execute().text
    }

    static String fetch(String url) {
        def conn = new URL("https://integration:Sup3rS3cret@legacy.example.com/api").openConnection()
        return conn.inputStream.text
    }
}
`;

const manifest = (name: string, type: string, version = "1.0.0") =>
  `Manifest-Version: 1.0\r\nBundle-ManifestVersion: 2\r\nBundle-Name: ${name}\r\nBundle-SymbolicName: ${name.replace(/\W+/g, "_")}; singleton:=true\r\nBundle-Version: ${version}\r\nSAP-BundleType: ${type}\r\nSAP-NodeType: IFLMAP\r\nSAP-RuntimeProfile: iflmap\r\n\r\n`;

async function artifactZip(name: string, type: string, version: string, files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("META-INF/MANIFEST.MF", manifest(name, type, version));
  zip.file(".project", `<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>${name}</name></projectDescription>`);
  zip.file("metainfo.prop", `#Store metainfo properties\ndescription=${name}\n`);
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

const RES = "src/main/resources";

export const SAMPLE_FILE_NAME = "Demo_Order_Integrations.zip";

/** Build an integration package export (.zip) in the layout CPI produces. */
export async function buildSamplePackage(): Promise<Uint8Array> {
  const artifacts: { id: string; name: string; displayName: string; type: string; bundle: string; version: string; files: Record<string, string> }[] = [
    {
      id: "8a3e5c1f0b9d4e2a8c7f6e5d4c3b2a10",
      name: "Order_Replication_to_S4",
      displayName: "Order Replication to S/4HANA",
      type: "IFlow",
      bundle: "IntegrationFlow",
      version: "1.0.7",
      files: {
        [`${RES}/scenarioflows/integrationflow/Order_Replication_to_S4.iflw`]: ORDER_IFLW,
        [`${RES}/script/logPayload.groovy`]: LOG_PAYLOAD,
        [`${RES}/script/transformOrders.groovy`]: TRANSFORM_ORDERS,
        [`${RES}/script/lookupCustomer.groovy`]: LOOKUP_CUSTOMER,
        [`${RES}/parameters.prop`]: ORDER_PARAMS,
        [`${RES}/parameters.propdef`]: `<?xml version="1.0" encoding="UTF-8"?><parameters/>`,
      },
    },
    {
      id: "1f2e3d4c5b6a49788796a5b4c3d2e1f0",
      name: "Customer_Master_Sync",
      displayName: "Customer Master Sync (C4C)",
      type: "IFlow",
      bundle: "IntegrationFlow",
      version: "2.1.0",
      files: {
        [`${RES}/scenarioflows/integrationflow/Customer_Master_Sync.iflw`]: CUSTOMER_IFLW,
        [`${RES}/script/mapCustomers.groovy`]: MAP_CUSTOMERS,
        [`${RES}/script/logError.groovy`]: LOG_ERROR,
        [`${RES}/parameters.prop`]: "C4C_Host=my000000.crm.ondemand.com\n",
      },
    },
    {
      id: "0c9b8a7f6e5d4c3b2a1908f7e6d5c4b3",
      name: "Shared_HTTP_Utilities",
      displayName: "Shared HTTP Utilities",
      type: "ScriptCollection",
      bundle: "ScriptCollection",
      version: "1.0.0",
      files: { [`${RES}/script/HttpUtil.groovy`]: HTTP_UTIL },
    },
  ];

  const pkg = new JSZip();
  const resources = [
    {
      id: "DemoOrderIntegrations",
      resourceType: "ContentPackage",
      name: "DemoOrderIntegrations",
      displayName: "Demo – Order Integrations",
      version: "1.0.0",
    },
    ...artifacts.map((a) => ({ id: a.id, uniqueId: a.name, resourceType: a.type, name: a.name, displayName: a.displayName, version: a.version })),
  ];
  pkg.file("resources.cnt", btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ resources })))));
  pkg.file("contentmetadata.md", btoa("Demo package for cpi-linter"));
  for (const a of artifacts) pkg.file(`${a.id}_content`, await artifactZip(a.name, a.bundle, a.version, a.files));
  return pkg.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
