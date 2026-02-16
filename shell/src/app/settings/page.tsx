"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SettingsMobileNav } from "@/components/settings/SettingsSidebar";

export default function SettingsPage() {
  const router = useRouter();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    setIsMobile(mq.matches);
    if (!mq.matches) {
      router.replace("/settings/agent");
    }
  }, [router]);

  if (!isMobile) return null;

  return (
    <div className="p-2">
      <SettingsMobileNav />
    </div>
  );
}
