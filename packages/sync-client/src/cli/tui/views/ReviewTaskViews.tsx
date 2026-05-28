import React from "react";
import { Box, Text } from "ink";

export function ReviewTaskViews({ reviews, tasks, noColor = false }: { reviews: ReadonlyArray<{ id: string; status?: string }>; tasks: ReadonlyArray<{ id: string; title: string; status?: string }>; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "yellow"} paddingX={1}>
      <Text bold>Reviews</Text>
      {reviews.map((review) => <Text key={review.id}>{`${review.id}${review.status ? ` · ${review.status}` : ""}`}</Text>)}
      <Text bold>Tasks</Text>
      {tasks.map((task) => <Text key={task.id}>{`${task.title}${task.status ? ` · ${task.status}` : ""}`}</Text>)}
    </Box>
  );
}
