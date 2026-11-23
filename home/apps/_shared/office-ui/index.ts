// Matrix OS office UI kit. Dependency-free React components styled with the
// shared --app-* and --identity-* tokens. Import the stylesheet once per app:
//   import "../../_shared/office-ui/office-ui.css";
export { AppFrame, type AppFrameProps } from "./AppFrame";
export {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
  type ToolbarButtonProps,
  type ToolbarGroupProps,
  type ToolbarProps,
} from "./Toolbar";
export { Dropdown, type DropdownItem, type DropdownProps } from "./Dropdown";
export { SplitPane, type SplitPaneProps } from "./SplitPane";
export { ListView, type ListItemState, type ListViewProps } from "./ListView";
export { TreeView, type TreeNode, type TreeViewProps } from "./TreeView";
export { Tabs, type TabItem, type TabsProps } from "./Tabs";
export { Dialog, type DialogProps } from "./Dialog";
export { Popover, Tooltip, type PopoverProps, type TooltipProps } from "./Popover";
export { ToastHost, ToastProvider, useToast, type ToastApi, type ToastHostProps, type ToastOptions } from "./Toast";
export {
  EmptyState,
  Skeleton,
  Spinner,
  type EmptyStateAction,
  type EmptyStateProps,
  type SkeletonProps,
  type SpinnerProps,
} from "./Feedback";
export {
  Checkbox,
  Select,
  TextField,
  type CheckboxProps,
  type SelectOption,
  type SelectProps,
  type TextFieldProps,
} from "./Fields";
export { Avatar, Badge, KeyHint, initialsFor, type AvatarProps, type BadgeProps, type KeyHintProps } from "./Display";
export {
  AgentPanel,
  type AgentMessage,
  type AgentPanelProps,
  type AgentResult,
  type AgentStatusLine,
} from "./AgentPanel";
export { ReviewBar, type ReviewBarProps } from "./ReviewBar";
export { ConfirmSend, type ConfirmSendProps } from "./ConfirmSend";
export { cx } from "./internal";
export { aiAccessMessage, readAiAccess, replyText, useAiAccess, type AiAccess, type AiAccessBridge } from "./ai-access";
