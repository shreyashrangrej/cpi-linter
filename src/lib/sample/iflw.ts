/** Tiny builder for iFlow (.iflw) BPMN XML in the shape CPI exports it. */

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type Props = Record<string, string>;

const ext = (props: Props, indent = "            ") =>
  `${indent}<bpmn2:extensionElements>\n` +
  Object.entries(props)
    .map(([k, v]) => `${indent}    <ifl:property>\n${indent}        <key>${k}</key>\n${indent}        <value>${esc(v)}</value>\n${indent}    </ifl:property>`)
    .join("\n") +
  `\n${indent}</bpmn2:extensionElements>`;

export interface Step {
  id: string;
  name: string;
  tag?: "callActivity" | "serviceTask";
  props: Props;
}

export interface Process {
  id: string;
  name: string;
  props?: Props;
  steps: Step[];
  /** End event kind of the main flow. */
  exceptionSubprocess?: { id: string; name: string; steps: Step[]; end: "error" | "message" | "escalation" };
}

export interface MessageFlow {
  id: string;
  name: string;
  source: string;
  target: string;
  props: Props;
}

export function contentModifierTable(rows: { name: string; type: string; value: string; action?: string }[]): string {
  return rows
    .map(
      (r) =>
        `<row><cell id='Action'>${r.action ?? "Create"}</cell><cell id='Type'>${r.type}</cell><cell id='Value'>${esc(r.value)}</cell><cell id='Default'></cell><cell id='Name'>${r.name}</cell><cell id='Datatype'></cell></row>`,
    )
    .join("");
}

export const scriptStep = (id: string, name: string, script: string): Step => ({
  id,
  name,
  props: {
    activityType: "Script",
    subActivityType: "GroovyScript",
    componentVersion: "1.1",
    cmdVariantUri: "ctype::FlowstepVariant/cname::GroovyScript/version::1.1.2",
    script,
    scriptFunction: "",
  },
});

const endDef = { error: "errorEventDefinition", message: "messageEventDefinition", escalation: "escalationEventDefinition" };

function renderSteps(steps: Step[], indent: string) {
  return steps
    .map((s) => {
      const tag = s.tag ?? "callActivity";
      return `${indent}<bpmn2:${tag} id="${s.id}" name="${esc(s.name)}">\n${ext(s.props, indent + "    ")}\n${indent}</bpmn2:${tag}>`;
    })
    .join("\n");
}

function renderProcess(p: Process) {
  const start = `StartEvent_${p.id}`;
  const end = `EndEvent_${p.id}`;
  const chain = [start, ...p.steps.map((s) => s.id), end];
  const flows = chain
    .slice(1)
    .map((to, i) => `        <bpmn2:sequenceFlow id="SequenceFlow_${p.id}_${i}" sourceRef="${chain[i]}" targetRef="${to}"/>`)
    .join("\n");

  let sub = "";
  if (p.exceptionSubprocess) {
    const e = p.exceptionSubprocess;
    const sChain = [`StartEvent_${e.id}`, ...e.steps.map((s) => s.id), `EndEvent_${e.id}`];
    sub = `
        <bpmn2:subProcess id="${e.id}" name="${esc(e.name)}" triggeredByEvent="true">
${ext({ activityType: "ErrorEventSubProcessTemplate", componentVersion: "1.1", cmdVariantUri: "ctype::FlowElementVariant/cname::ErrorEventSubProcessTemplate/version::1.1.0" }, "            ")}
            <bpmn2:startEvent id="StartEvent_${e.id}" name="Error Start">
                <bpmn2:errorEventDefinition/>
            </bpmn2:startEvent>
${renderSteps(e.steps, "            ")}
            <bpmn2:endEvent id="EndEvent_${e.id}" name="End">
                <bpmn2:${endDef[e.end]}/>
            </bpmn2:endEvent>
${sChain
  .slice(1)
  .map((to, i) => `            <bpmn2:sequenceFlow id="SequenceFlow_${e.id}_${i}" sourceRef="${sChain[i]}" targetRef="${to}"/>`)
  .join("\n")}
        </bpmn2:subProcess>`;
  }

  return `    <bpmn2:process id="${p.id}" name="${esc(p.name)}">
${ext({ transactionTimeout: "30", transactionalHandling: "Not Required", componentVersion: "1.1", ...p.props }, "        ")}
        <bpmn2:startEvent id="${start}" name="Start">
            <bpmn2:messageEventDefinition/>
        </bpmn2:startEvent>
${renderSteps(p.steps, "        ")}
        <bpmn2:endEvent id="${end}" name="End">
            <bpmn2:messageEventDefinition/>
        </bpmn2:endEvent>
${flows}${sub}
    </bpmn2:process>`;
}

export function iflw({ processes, messageFlows }: { processes: Process[]; messageFlows: MessageFlow[] }): string {
  const participants = processes
    .map(
      (p) =>
        `        <bpmn2:participant id="Participant_${p.id}" ifl:type="IntegrationProcess" name="${esc(p.name)}" processRef="${p.id}"/>`,
    )
    .join("\n");
  const flows = messageFlows
    .map(
      (m) =>
        `        <bpmn2:messageFlow id="${m.id}" name="${esc(m.name)}" sourceRef="${m.source}" targetRef="${m.target}">\n${ext(m.props)}\n        </bpmn2:messageFlow>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_1">
    <bpmn2:collaboration id="Collaboration_1" name="Default Collaboration">
${ext({ namespaceMapping: "", allowedHeaderList: "", httpSessionHandling: "None", ServerTrace: "false", returnExceptionToSender: "false", cmdVariantUri: "ctype::IFlowVariant/cname::IFlowConfiguration/version::1.2.4" }, "        ")}
        <bpmn2:participant id="Participant_Sender" ifl:type="EndpointSender" name="Sender"/>
        <bpmn2:participant id="Participant_Receiver" ifl:type="EndpointRecevier" name="Receiver"/>
${participants}
${flows}
    </bpmn2:collaboration>
${processes.map(renderProcess).join("\n")}
</bpmn2:definitions>
`;
}
