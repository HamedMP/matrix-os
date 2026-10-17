import "../../../packages/ui/src/chat-agents/chat-agents.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotComposerControls } from "../../../packages/ui/src/chat-agents/bots/BotComposerControls";
import { PromptInput } from "../../../desktop/src/renderer/src/features/chat/elements/prompt-input";
import { ConversationTranscript } from "../../../desktop/src/renderer/src/components/conversation/transcript";
import type { ConversationTurnPresentation } from "../../../desktop/src/renderer/src/components/conversation/presentation";
import { ChatInput } from "../../../shell/src/components/chat/ChatInput";
import type { ChatComposerDraft } from "../../../shell/src/components/chat/useChatComposerDraft";

const name = "Synthetic attachment verification assistant with a long display name";
const model = "GPT-6.1 Sol with a long subscription model display name";
const agent = { id: "bot_fixture01", name, revision: 1, recipeRef: { recipeId: "writer", version: "1" },
  selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6.1-sol" } };
const client = { list: async () => ({ enabled: true, agents: [agent] }) } as never;
const catalog = { instances: [{ id: "matrix_chatgpt_plan", driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "ChatGPT subscription",
  models: [{ id: "gpt-6.1-sol", displayName: model }] }] } as never;
const speechClient = { capabilities: async () => ({ fileTranscription: { status: "ready", dictation: {
  enabled: true, supportedMediaTypes: ["audio/wav"], maxBytes: 1024, maxDurationMs: 60000,
} } }), transcribe: async () => ({ outcome: "no_speech" }), cancel: async () => undefined } as never;
const capture = { isSupported: () => true, start: async () => ({ stop: async () => new Blob([], { type: "audio/wav" }), cancel: async () => undefined }) };
function Fixture() {
  const [active, setActive] = useState(true), [value, setValue] = useState("Unsaved fixture draft");
  const [action, setAction] = useState("");
  const [webBot, setWebBot] = useState(true);
  const web = document.documentElement.dataset.surface === "web";
  const composer = { text: value, setText: setValue, resources: [], setResources: () => undefined,
    setDraft: (draft: { text?: string }) => setValue(draft.text ?? ""), clear: () => setValue(""), requestId: "req_fixture" } as unknown as ChatComposerDraft;
  const turn: ConversationTurnPresentation = {
    id: "turn_fixture", startedAt: Date.now() - 12000, endedAt: Date.now(), active,
    work: [{ kind: "activity-group", id: "activity_fixture", activities: [
      { id: "reading", kind: "read", label: "Reading a file", state: "completed", detail: "Synthetic file result" },
      { id: "model", kind: "phase", label: active ? "Working" : "Worked", state: active ? "running" : "completed", preview: `Current model: ${model}`, previewKind: "text" },
    ] }],
    final: active ? undefined : { kind: "message", id: "final_fixture", role: "assistant", phase: "final", timestamp: Date.now(),
      markdown: "First final paragraph.\n\nSecond final paragraph.\n\n```text\nfixture code line one\nfixture code line two\n```", copyText: "Synthetic final reply" },
  };
  return <>
    <button onClick={() => setActive(false)}>Complete fixture</button>
    {web ? <button onClick={() => setWebBot(value => !value)}>Toggle Web bot</button> : null}
    <main id="fixture-column" style={{ width: 320 }}>
      <section id="transcript" style={{ height: 410 }}><ConversationTranscript turns={[turn]} callbacks={{ copyText: async () => undefined }}/></section>
      {web ? <div id="composer"><ChatInput composer={composer} scope="web_fixture" permissionMode="default" connected busy={active}
        activeRunId={active ? "run_fixture" : undefined} onAbortCurrent={() => setAction("stop")} onSubmit={() => setAction("send")}
        attachmentsEnabled botContext={webBot} speechClient={speechClient} speechCaptureAdapter={capture}
        botControls={webBot ? <BotComposerControls agentId={agent.id} client={client} catalog={catalog}/> : undefined}/></div>
      : <div className="@container/chat-composer" id="composer">
        <PromptInput value={value} onChange={setValue} onSubmit={() => setAction("send")} onAbort={() => setAction("stop")} busy={active}
          controls={<><button className="size-8 shrink-0" aria-label="Attach files" onClick={() => setAction("attach")}>+</button><button className="size-8 shrink-0" aria-label="Choose folder" onClick={() => setAction("folder")}>▣</button></>}
          trailingControls={<><button className="size-8 shrink-0" aria-label="Microphone" onClick={() => setAction("microphone")}>♩</button><BotComposerControls agentId={agent.id} client={client} catalog={catalog}/></>}/>
      </div>}
      <output id="fixture-action">{action}</output>
    </main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
