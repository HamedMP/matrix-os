import { useEffect } from "react";
import { COMPANY_DRIVE_MOBILE_CHAT_EVENT } from "@/stores/company-drive-chat-draft";
/** Focus signal only; the Chat consumer checks the owner/session/runtime-bound draft. */
export function useCompanyDriveChatLaunch(openChat: () => void): void {
    useEffect(() => { window.addEventListener(COMPANY_DRIVE_MOBILE_CHAT_EVENT, openChat); return () => window.removeEventListener(COMPANY_DRIVE_MOBILE_CHAT_EVENT, openChat); }, [openChat]);
}
