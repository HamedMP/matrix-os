"use client";

import type { CSSProperties } from "react";
import { motion } from "framer-motion";
import { fadeUp, staggerContainer, tapScale } from "@/lib/motion";
import { MobileQuickActions } from "./MobileQuickActions";
import { MobileAppIcon } from "./MobileAppIcon";
import type { MobileApp } from "./mobile-app";

const LAUNCHER_APP_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: "4px 0",
  width: "100%",
  minWidth: 0,
  borderRadius: 12,
};

const LAUNCHER_APP_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: "16px",
  textAlign: "center",
  width: "100%",
  minHeight: 32,
  overflowWrap: "anywhere",
  whiteSpace: "normal",
};

interface LauncherProps {
  apps: MobileApp[];
  onOpen: (app: MobileApp) => void;
  onOpenSettings: () => void;
  openStackCount: number;
  onShowSwitcher: () => void;
  onCloseAll: () => void;
}

export function MobileLauncher({ apps, onOpen, onOpenSettings, openStackCount, onShowSwitcher, onCloseAll }: LauncherProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>Apps</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            {apps.length} installed{openStackCount > 0 ? ` · ${openStackCount} open` : ""}
          </div>
        </div>
        <MobileQuickActions
          openStackCount={openStackCount}
          onOpenSettings={onOpenSettings}
          onShowSwitcher={onShowSwitcher}
          onCloseAll={onCloseAll}
        />
      </div>
      <motion.div
        className="flex-1 overflow-y-auto"
        variants={staggerContainer()}
        initial="initial"
        animate="animate"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(76px, 1fr))",
          columnGap: 8,
          rowGap: 20,
          padding: "8px 16px 24px",
          width: "100%",
          maxWidth: 680,
          alignSelf: "center",
          alignContent: "start",
        }}
      >
        {apps.map((app) => (
          <motion.button
            key={app.id}
            data-testid={`mobile-launcher-app-${app.path}`}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
            type="button"
            onClick={() => onOpen(app)}
            variants={fadeUp}
            {...tapScale}
            style={LAUNCHER_APP_BUTTON_STYLE}
          >
            <MobileAppIcon slug={app.iconSlug} size={56} />
            <span style={LAUNCHER_APP_LABEL_STYLE}>{app.name}</span>
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}

