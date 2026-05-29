import React from "react";
import { Box, Text } from "ink";
import type { ProjectSummary, WorktreeSummary } from "../projects.js";

export function ProjectViews({ projects, worktrees, noColor = false }: { projects: readonly ProjectSummary[]; worktrees: readonly WorktreeSummary[]; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "cyan"} paddingX={1}>
      <Text bold>Projects</Text>
      {projects.map((project) => <Text key={project.slug}>{project.name ?? project.slug}</Text>)}
      <Text bold>Worktrees</Text>
      {worktrees.map((worktree) => <Text key={worktree.id}>{`${worktree.id} · ${worktree.projectSlug}${worktree.branch ? ` · ${worktree.branch}` : ""}`}</Text>)}
    </Box>
  );
}
