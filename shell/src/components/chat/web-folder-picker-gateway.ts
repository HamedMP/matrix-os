import { createContext } from "react";

/** The routed computer's gateway, provided by the dialog that hosts the folder picker. */
export const WebFolderPickerGateway = createContext<string | null>(null);
