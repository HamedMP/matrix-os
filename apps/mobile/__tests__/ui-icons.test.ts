import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import Archive02Icon from "@hugeicons/core-free-icons/Archive02Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ArrowUp02Icon from "@hugeicons/core-free-icons/ArrowUp02Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GridViewIcon from "@hugeicons/core-free-icons/GridViewIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import Share08Icon from "@hugeicons/core-free-icons/Share08Icon";
import SidebarLeftIcon from "@hugeicons/core-free-icons/SidebarLeftIcon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import SquareLock02Icon from "@hugeicons/core-free-icons/SquareLock02Icon";
import StopIcon from "@hugeicons/core-free-icons/StopIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import UserMultiple02Icon from "@hugeicons/core-free-icons/UserMultiple02Icon";

import * as icons from "../components/ui/icons";

describe("role icons", () => {
  it("maps every role to its Hugeicon", () => {
    expect(icons).toMatchObject({
      ChatsTabIcon: Message01Icon,
      AgentsTabIcon: SparklesIcon,
      AppsTabIcon: GridViewIcon,
      TerminalTabIcon: ComputerTerminal01Icon,
      SettingsTabIcon: Settings02Icon,
      SidePanelIcon: SidebarLeftIcon,
      NewChatIcon: PencilEdit02Icon,
      BackIcon: ArrowLeft01Icon,
      InfoIcon: InformationCircleIcon,
      MoreIcon: MoreHorizontalIcon,
      CloseIcon: Cancel01Icon,
      AddIcon: Add01Icon,
      MicIcon: Mic01Icon,
      SendIcon: ArrowUp02Icon,
      StopIcon,
      DisclosureDownIcon: ArrowDown01Icon,
      ChevronRightIcon: ArrowRight01Icon,
      SearchIcon: Search01Icon,
      CheckIcon: Tick02Icon,
      LoadingIcon: Loading03Icon,
      ChatIcon: Message01Icon,
      FolderIcon: Folder01Icon,
      SharedIcon: UserMultiple02Icon,
      DocumentIcon: File01Icon,
      LockIcon: SquareLock02Icon,
      EditIcon: PencilEdit02Icon,
      ShareIcon: Share08Icon,
      ArchiveIcon: Archive02Icon,
      DeleteIcon: Delete02Icon,
    });
  });

  it("exports nothing but the 29 roles", () => {
    expect(Object.keys(icons)).toHaveLength(29);
    for (const icon of Object.values(icons)) {
      expect(Array.isArray(icon)).toBe(true);
    }
  });
});
