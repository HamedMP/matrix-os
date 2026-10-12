import { useState } from "react";

import { ModelSheet } from "@/components/chat/ModelSheet";
import { Sheet } from "@/components/ui";

import { ChatHomeFrame } from "./ChatFrames";
import { SAMPLE_CREDIT, SAMPLE_MODEL_ENGINES } from "./sample-models";

const noop = () => {};

/** Frame C3: the model sheet open over the new chat. The trigger opens it again. */
export function ModelSheetFrame() {
  const [open, setOpen] = useState(true);

  return (
    <>
      <ChatHomeFrame onModelPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} testID="model-sheet-frame">
        <ModelSheet
          engines={SAMPLE_MODEL_ENGINES}
          options={[]}
          credit={SAMPLE_CREDIT}
          onSelectModel={() => setOpen(false)}
          onSelectOption={noop}
        />
      </Sheet>
    </>
  );
}
