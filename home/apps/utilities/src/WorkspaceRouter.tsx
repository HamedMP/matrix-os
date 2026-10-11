import React, { lazy } from "react";
import { toolAvailability } from "./tool-availability";
import { workspaceKind, type UtilityTool } from "./utilities-model";

const Text = lazy(() => import("./vendor/workspaces/ToolWorkspace").then((module) => ({ default: module.ToolWorkspace })));
const Pdf = lazy(() => import("./vendor/workspaces/PdfWorkspace").then((module) => ({ default: module.PdfWorkspace })));
const Podcast = lazy(() => import("./vendor/workspaces/PdfPodcastWorkspace").then((module) => ({ default: module.PdfPodcastWorkspace })));
const Signature = lazy(() => import("./vendor/workspaces/PdfSignatureWorkspace").then((module) => ({ default: module.PdfSignatureWorkspace })));
const Image = lazy(() => import("./vendor/workspaces/ImageWorkspace").then((module) => ({ default: module.ImageWorkspace })));
const Audio = lazy(() => import("./vendor/workspaces/AudioWorkspace").then((module) => ({ default: module.AudioWorkspace })));
const Extra = lazy(() => import("./vendor/workspaces/ExtraWorkspace").then((module) => ({ default: module.ExtraWorkspace })));
const Editor = lazy(() => import("./vendor/workspaces/EditorWorkspace").then((module) => ({ default: module.EditorWorkspace })));
const Collaboration = lazy(() => import("./vendor/workspaces/CollaborationWorkspace").then((module) => ({ default: module.CollaborationWorkspace })));
const Workflow = lazy(() => import("./vendor/workspaces/WorkflowWorkspace").then((module) => ({ default: module.WorkflowWorkspace })));
const LocalAi = lazy(() => import("./vendor/workspaces/LocalAiWorkspace").then((module) => ({ default: module.LocalAiWorkspace })));

export function WorkspaceRouter({ tool }: { tool: UtilityTool }) {
  const availability = toolAvailability(tool);
  if (!availability.available) return <div className="utilities-feedback" role="status"><h2>Available on the website</h2><p>{availability.reason}</p><a href={availability.websiteUrl} target="_blank" rel="noopener noreferrer">Open {tool.title} on matrix-os.com ↗</a></div>;
  switch (workspaceKind(tool)) {
    case "text": return <Text slug={tool.slug} example={tool.example} />;
    case "pdf": return <Pdf slug={tool.slug} />;
    case "pdf-podcast": return <Podcast />;
    case "pdf-signature": return <Signature />;
    case "image": return <Image slug={tool.slug} />;
    case "audio": return <Audio slug={tool.slug} />;
    case "extra": return <Extra slug={tool.slug} />;
    case "editor": return <Editor slug={tool.slug} />;
    case "collaboration": return <Collaboration slug={tool.slug} />;
    case "workflow": return <Workflow />;
    case "local-ai": return <LocalAi slug={tool.slug} />;
    default: return <p role="alert">This tool is unavailable. Choose another tool from Utilities.</p>;
  }
}
