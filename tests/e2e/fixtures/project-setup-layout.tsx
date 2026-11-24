import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChatMessage } from "../../../shell/src/lib/chat";
import { ChatApp } from "../../../shell/src/components/ChatApp";

const firstQuestion: ChatMessage = { id: "msg_setup_question", role: "assistant", content: "Who should see the harbor schedule?", timestamp: 2 };
const initialMessages = [
  { id: "msg_setup_start", role: "user", content: "Set up this project with Chat.", timestamp: 1 },
  firstQuestion,
] satisfies ChatMessage[];

function SetupWindow() {
  const [phase, setPhase] = useState<"opening" | "generating" | "review">("opening");
  const [closed, setClosed] = useState(false);
  const messages: ChatMessage[] = phase === "opening" ? [...initialMessages] : [
    ...initialMessages,
    { id: "msg_setup_answer", role: "user", content: "Plan weekly shifts for the volunteers.", timestamp: 3 },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `msg_setup_preference_${index}`, role: "assistant" as const, content: `Discussed scheduling preference ${index + 1}.`, timestamp: 4 + index,
    })),
    ...(phase === "review" ? [{
      id: "msg_setup_review", role: "assistant", content: "Review the weekly schedule setup.", timestamp: 17,
    }] : []),
  ];
  return (
    <>
      <div className="flex gap-2">
        <button type="button" onClick={() => setPhase("generating")}>Receive running Chat frame</button>
        <button type="button" onClick={() => setPhase("review")}>Receive completed Chat frame</button>
      </div>
      <div data-test-window style={{ width: 624, height: 540 }}>
        {closed ? <p>Returned to Harbor project</p> : (
          <ChatApp messages={messages} sessionId="chat_setup" activeConversationTitle="Project setup"
            chatProjectId="proj_harbor" projectSkillRootAvailable={phase === "generating" ? "pending" : true}
            conversations={[]} connected busy={phase === "generating"}
            onSubmit={() => {}} onSwitchConversation={() => {}} onNewChat={() => setClosed(true)} />
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<SetupWindow />);
