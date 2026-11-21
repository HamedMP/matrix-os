/**
 * The chat-state derivations Desktop and Web share, so the three clients agree
 * on which state a chat is in and how its read state merges.
 *
 * They are reached by path because `@matrix-os/ui` does not export them on
 * their own: its main entry also brings in the web components, which the
 * native bundle cannot load. Once the package exports these files as
 * subpaths, import them from there and remove this file.
 */
export {
  resolveCanonicalChatAttention,
  resolveCanonicalChatLifecycleGroup,
  type CanonicalChatAttentionState,
} from "../../../packages/ui/src/chat/attention-state";
export { mergeChatReadState } from "../../../packages/ui/src/chat/read-state";
