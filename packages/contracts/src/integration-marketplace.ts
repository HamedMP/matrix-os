export type IntegrationAuthType = "oauth" | "keys";
export interface IntegrationCatalogItem {
  id: string;
  name: string;
  category: string;
  description?: string;
  authType?: IntegrationAuthType;
  logoUrl?: string;
}

// Shared presentation data for every OS view. Unknown authentication stays unknown.
export const INTEGRATION_PRESENTATION: Record<string, { description: string; authType: IntegrationAuthType }> = {
  twitter: { description: "Read posts and account activity", authType: "oauth" },
  gmail: { description: "Read, search, and send email", authType: "oauth" },
  google_calendar: { description: "Manage events and schedule meetings", authType: "oauth" },
  google_drive: { description: "Search, read, and upload files", authType: "oauth" },
  google_sheets: { description: "Read and update spreadsheets", authType: "oauth" },
  google_docs: { description: "Read, create, and edit documents", authType: "oauth" },
  google_slides: { description: "Read presentations and slides", authType: "oauth" },
  github: { description: "Manage repos, issues, and pull requests", authType: "oauth" },
  linear: { description: "Manage issues, projects & team workflows", authType: "oauth" },
  slack: { description: "Send messages and manage channels", authType: "oauth" },
  discord: { description: "Read servers and channels, send messages", authType: "oauth" },
  notion: { description: "Search, update, and organize workspace", authType: "oauth" },
  figma: { description: "Read design files and comments", authType: "oauth" },
  posthog: { description: "Existing API-key connection for product analytics", authType: "keys" },
  posthog_oauth: { description: "Explore projects and product analytics", authType: "oauth" },
  jira: { description: "Read issues and project boards", authType: "oauth" },
  stripe: { description: "Read customers and payment activity", authType: "keys" },
  granola: { description: "Read meeting notes and transcripts", authType: "oauth" },
  asana: { description: "Read workspaces, projects, and tasks", authType: "oauth" },
  airtable: { description: "Read bases, tables, and records", authType: "oauth" },
  clickup: { description: "Read workspaces and tasks", authType: "oauth" },
  todoist: { description: "Read projects and tasks", authType: "oauth" },
  dropbox: { description: "Browse files and folders", authType: "oauth" },
  box: { description: "Read files and folder contents", authType: "oauth" },
  microsoft_outlook: { description: "Read email and mail folders", authType: "oauth" },
  microsoft_onedrive: { description: "Browse files and read file details", authType: "oauth" },
  microsoft_teams: { description: "Read teams and channels", authType: "oauth" },
  hubspot: { description: "Read contacts, companies, and deals", authType: "oauth" },
  zoom: { description: "Read upcoming meetings and meeting details", authType: "oauth" },
  google_contacts: { description: "Read contacts and people", authType: "oauth" },
  microsoft_outlook_calendar: { description: "Read calendars and schedule events", authType: "oauth" },
  quickbooks: { description: "Read accounting records and invoices", authType: "oauth" },
  xero_accounting_api: { description: "Read organizations, invoices and payments", authType: "oauth" },
  zendesk: { description: "Read support tickets and customers", authType: "oauth" },
  intercom: { description: "Read contacts and support conversations", authType: "oauth" },
  loops: { description: "Read email contacts, lists and templates", authType: "oauth" },
  lemlist: { description: "Read outreach campaigns and performance", authType: "oauth" },
  bokio: { description: "Read company accounts, invoices and receipts", authType: "oauth" },
};

export function integrationDescription(service: IntegrationCatalogItem): string {
  return service.description ?? INTEGRATION_PRESENTATION[service.id]?.description ?? "Connect this app to Matrix";
}
export function integrationAuthType(service: IntegrationCatalogItem): IntegrationAuthType | undefined {
  return service.authType ?? INTEGRATION_PRESENTATION[service.id]?.authType;
}
export function integrationCategory(service: IntegrationCatalogItem): string {
  if (service.id === "loops") return "Marketing";
  if (["zendesk", "intercom"].includes(service.id)) return "Customer support";
  if (["google_drive", "dropbox", "box", "microsoft_onedrive"].includes(service.id)) return "Files";
  if (["gmail", "microsoft_outlook", "zoom"].includes(service.id)) return "Communication";
  if (["google_slides", "figma"].includes(service.id)) return "Design";
  const categories: Record<string, string> = {
    google: "Productivity", productivity: "Productivity", project_management: "Productivity", developer: "Developer tools",
    communication: "Communication", design: "Design", analytics: "Data", data: "Data",
    finance: "Finance", sales: "Sales", crm: "Sales", files: "Files", social: "Social",
  };
  return categories[service.category] ?? "Other apps";
}
export function buildIntegrationSections<T extends IntegrationCatalogItem>(services: readonly T[], options: {
  query?: string; oauthOnly?: boolean; connectedOnly?: boolean; connectedIds?: readonly string[];
} = {}): Array<{ title: string; services: T[] }> {
  const query = (options.query ?? "").trim().toLocaleLowerCase();
  const filtered = services.filter(service =>
    (!options.oauthOnly || integrationAuthType(service) === "oauth")
    && (!options.connectedOnly || options.connectedIds?.includes(service.id))
    && (!query || `${service.name} ${integrationDescription(service)} ${integrationCategory(service)}`.toLocaleLowerCase().includes(query)),
  );
  const titles = ["Productivity", "Communication", "Files", "Design", "Developer tools", "Sales", "Customer support", "Marketing", "Data", "Finance", "Social", "Other apps"];
  return titles.map(title => ({ title, services: filtered.filter(service => integrationCategory(service) === title) }))
    .filter(section => section.services.length > 0);
}
