import { useRouter } from "expo-router";
import CalculatorIcon from "@hugeicons/core-free-icons/CalculatorIcon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import FileTextIcon from "@hugeicons/core-free-icons/FileTextIcon";
import GameController03Icon from "@hugeicons/core-free-icons/GameController03Icon";
import Image02Icon from "@hugeicons/core-free-icons/Image02Icon";
import MusicNote01Icon from "@hugeicons/core-free-icons/MusicNote01Icon";
import PaintBrush01Icon from "@hugeicons/core-free-icons/PaintBrush01Icon";
import SunCloud02Icon from "@hugeicons/core-free-icons/SunCloud02Icon";

import { GridTile, GridTileGrid, MockSearchField } from "@/components/mock-shell/MockControls";
import { MockPage } from "@/components/mock-shell/MockPage";
import { Spacer } from "@/components/ui";

const apps = [
  { name: "Chess", icon: GameController03Icon },
  { name: "Notes", icon: FileTextIcon },
  { name: "Tasks", icon: CheckmarkCircle02Icon },
  { name: "Weather", icon: SunCloud02Icon },
  { name: "Whiteboard", icon: PaintBrush01Icon },
  { name: "Calculator", icon: CalculatorIcon },
  { name: "Clock", icon: Clock01Icon },
  { name: "Music", icon: MusicNote01Icon },
  { name: "Gallery", icon: Image02Icon },
];

export default function AppsScreen() {
  const router = useRouter();

  return (
    <MockPage title="Apps" subtitle="Experiences installed on solar-vale">
      <MockSearchField placeholder="Search apps" />
      <Spacer size="xl" />
      <GridTileGrid>
        {apps.map((app) => (
          <GridTile
            key={app.name}
            label={app.name}
            icon={app.icon}
            onPress={() => router.push({ pathname: "/app-preview/[app]", params: { app: app.name } } as never)}
          />
        ))}
      </GridTileGrid>
    </MockPage>
  );
}
