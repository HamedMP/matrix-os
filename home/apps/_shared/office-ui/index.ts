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
export { Ribbon, type BackstageState, type RibbonProps } from "./Ribbon";
export type {
  BackstageApi,
  BackstageItem,
  RibbonBackstage,
  RibbonBackstageTab,
  RibbonButtonItem,
  RibbonColorItem,
  RibbonColorSwatch,
  RibbonGalleryItem,
  RibbonGalleryOption,
  RibbonGroup,
  RibbonItem,
  RibbonMenuButtonItem,
  RibbonMenuItem,
  RibbonPanelTab,
  RibbonSelectItem,
  RibbonSelectOption,
  RibbonSeparatorItem,
  RibbonSplitItem,
  RibbonStackItem,
  RibbonTab,
  RibbonToggleItem,
} from "./ribbon-types";
export { DEFAULT_RIBBON_PALETTE, clearRecentColors, recentColors } from "./RibbonPickers";
export { fitGroups } from "./ribbon-layout";
export { BackToHome, DocumentTitleBar, type BackToHomeProps, type DocumentTitleBarProps, type SaveState } from "./TitleBar";
export {
  CSV_MIME,
  DOCX_MIME,
  LocalFileError,
  MAX_LOCAL_FILE_BYTES,
  TSV_MIME,
  XLSX_MIME,
  describeAccept,
  downloadBytes,
  fileMatchesAccept,
  pickLocalFile,
  readDroppedFile,
  type DroppedFiles,
  type LocalFile,
  type LocalFileErrorCode,
  type LocalFileOptions,
} from "./local-files";
export { FileDropZone, type FileDropZoneProps } from "./FileDropZone";
export { cx } from "./internal";
export { watchLeave, type LeaveGuard } from "./leave-guard";
export { aiAccessMessage, readAiAccess, replyText, useAiAccess, type AiAccess, type AiAccessBridge } from "./ai-access";
export { FileThumb, type FileThumbKind, type FileThumbProps } from "./FileThumb";
export { RecentFileList, type RecentEntry, type RecentFileListProps } from "./RecentFileList";
export { MatrixFileBrowser, type BrowserFiles, type MatrixFileBrowserProps } from "./MatrixFileBrowser";
export { OfficeStartScreen, type OfficeStartScreenProps, type StartAction, type StartTemplate } from "./OfficeStartScreen";
export {
  DEFAULT_START_DIR,
  MAX_BROWSER_ROWS,
  START_FOLDER_KEY,
  SYSTEM_ROOT_DIRS,
  breadcrumbTrail,
  browsableEntries,
  createStartFolderMemory,
  hiddenSystemCount,
  normalizeStartDir,
  startDirCandidates,
  exactTime,
  extensionOf,
  filterEntries,
  folderLabel,
  parentDir,
  relativeTime,
  sortEntries,
  type Crumb,
  type StartFileEntry,
  type StartFolderBridge,
  type StartFolderMemory,
  type StartSort,
} from "./start-model";
