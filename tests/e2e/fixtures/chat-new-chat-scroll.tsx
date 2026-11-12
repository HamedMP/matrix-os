import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatNewChatContent } from "../../../packages/ui/src/chat/new-chat/ChatNewChatContent";

// A composer taller than a short phone screen: a long draft and attachments push Send below the fold.
function Fixture() {
  const [sent, setSent] = useState(0);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <ChatNewChatContent logo={null} layout="narrow" onSelect={() => {}} composer={(
      <div data-testid="tall-composer" style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ height: 620, background: "#eef0ed" }}>Long draft with attachments</div>
        <button type="button" onClick={() => setSent(value => value + 1)}>Send</button>
        <output id="sent">{sent}</output>
      </div>
    )} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
