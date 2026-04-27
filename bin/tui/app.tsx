import React, { useState } from "react";
import { Box, Text, render, renderToString, useApp, useInput } from "ink";
import type { TuiDashboardModel } from "./dashboard.js";

export function TuiDashboardApp({ model }: { model: TuiDashboardModel }) {
  const { exit } = useApp();
  const [selectedSection, setSelectedSection] = useState(0);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelectedSection((current) => Math.min(model.sections.length - 1, current + 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelectedSection((current) => Math.max(0, current - 1));
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Matrix OS Workspace</Text>
      <Text color="gray">j/k or arrows navigate · Enter attaches · q exits</Text>
      <Box marginTop={1} flexDirection="column">
        {model.sections.map((section, index) => (
          <Box key={section.title} flexDirection="column" marginBottom={1}>
            <Text bold color={index === selectedSection ? "green" : "white"}>
              {index === selectedSection ? ">" : " "} {section.title}
            </Text>
            {(section.rows.length > 0 ? section.rows : ["No records"]).slice(0, 8).map((row) => (
              <Text key={row} color="gray">  {row}</Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text color="yellow">Actions: {model.actions.join(", ")}</Text>
    </Box>
  );
}

export function renderInkDashboardToString({ model }: { model: TuiDashboardModel }): string {
  return renderToString(<TuiDashboardApp model={model} />);
}

export async function renderInkDashboard({ model }: { model: TuiDashboardModel }): Promise<void> {
  const instance = render(<TuiDashboardApp model={model} />);
  await instance.waitUntilExit();
}
