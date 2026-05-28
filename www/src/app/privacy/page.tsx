import type { Metadata } from "next";
import { LegalList, LegalPage } from "../legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | Matrix OS",
  description:
    "Privacy Policy for Matrix OS, the AI-native cloud computer operated by Finna Labs Inc.",
  openGraph: {
    title: "Privacy Policy | Matrix OS",
    description:
      "How Matrix OS handles account data, workspace data, analytics, integrations, AI providers, retention, and user rights.",
    url: "https://matrix-os.com/privacy",
    siteName: "Matrix OS",
    type: "article",
  },
};

const lastUpdated = "May 28, 2026";

const sections = [
  {
    title: "Scope",
    content: (
      <>
        <p>
          This Privacy Policy explains how Finna Labs Inc. collects, uses, shares, and
          protects information when you visit matrix-os.com, sign in to Matrix OS, use a
          hosted Matrix OS workspace, connect integrations, or contact support.
        </p>
        <p>
          Matrix OS is designed so your workspace data is owner-controlled rather than
          casually mixed into the platform. This policy describes the service as operated
          by Finna Labs Inc.; self-hosted deployments may be controlled by the person or
          organization running them.
        </p>
      </>
    ),
  },
  {
    title: "Data We Collect",
    content: (
      <>
        <p>Depending on how you use Matrix OS, we may process:</p>
        <LegalList>
          <li>account and authentication data, such as name, email, session, and login details handled through Clerk;</li>
          <li>workspace data, such as prompts, files, apps, settings, terminal activity, agent memory, messages, and generated output;</li>
          <li>structured app and workspace records stored in a local Postgres database for your Matrix environment;</li>
          <li>integration metadata, OAuth connection status, provider identifiers, and data returned from connected services through Pipedream or similar providers;</li>
          <li>usage, diagnostics, error, device, browser, IP, and performance information from Matrix OS, Vercel, PostHog, and server logs; and</li>
          <li>support communications and feedback you send to support@matrix-os.com.</li>
        </LegalList>
      </>
    ),
  },
  {
    title: "Where Data Lives",
    content: (
      <>
        <p>
          In the hosted service, an active user may receive a customer VPS. Your Matrix
          home stores inspectable files such as apps, settings, exports, agent
          instructions, icons, and project material. Your local Postgres database stores
          structured app records, canvas/workspace state, social state, and other records
          that need reliable querying.
        </p>
        <p>
          The platform keeps control-plane data needed to authenticate users, route
          requests, provision workspaces, manage integration metadata, recover service
          state, prevent abuse, and provide support. Backup and recovery systems may
          store snapshots or metadata so your workspace can be restored.
        </p>
      </>
    ),
  },
  {
    title: "How We Use Data",
    content: (
      <>
        <p>We use information to:</p>
        <LegalList>
          <li>provide, secure, monitor, and improve Matrix OS;</li>
          <li>authenticate accounts and route users to the right workspace;</li>
          <li>provision, operate, update, back up, and recover customer VPS environments;</li>
          <li>run AI agents, generated apps, terminal sessions, and approved integrations at your direction;</li>
          <li>debug errors, measure reliability, understand product usage, and prevent abuse;</li>
          <li>communicate about support, security, service changes, and account activity; and</li>
          <li>comply with legal obligations and enforce service terms.</li>
        </LegalList>
      </>
    ),
  },
  {
    title: "AI Providers",
    content: (
      <>
        <p>
          Matrix OS can route prompts, context, files, tool results, code, and other
          workspace data to AI model providers or user-configured agents when you ask
          Matrix OS to perform an agentic task. The exact provider can depend on your
          configuration, credentials, model selection, and the feature being used.
        </p>
        <p>
          You should not provide sensitive information to an AI task unless you want that
          information processed for the requested task. User-provided model keys or
          connected accounts may also be governed by the relevant provider&apos;s terms and
          privacy policy.
        </p>
      </>
    ),
  },
  {
    title: "Sharing",
    content: (
      <>
        <p>
          We do not sell your personal information. We may share information with service
          providers that help operate Matrix OS, including authentication, hosting,
          analytics, observability, error reporting, support, email, storage, infrastructure,
          integration, and payment providers.
        </p>
        <p>
          Current code and deployment paths reference providers such as Clerk, Vercel,
          PostHog, Pipedream, cloud infrastructure, AI model providers, and connected
          third-party services you authorize. We may also disclose information for legal,
          safety, security, corporate transaction, or rights-enforcement reasons.
        </p>
      </>
    ),
  },
  {
    title: "Integrations",
    content: (
      <>
        <p>
          If you connect external services, Matrix OS uses the permissions you grant to
          perform requested actions such as reading context, creating or updating work
          items, sending messages, or synchronizing connection status. Provider credentials
          and tokens are handled through the platform-owned integration flow and scoped
          service routes.
        </p>
        <p>
          You can disconnect integrations when you no longer want Matrix OS to use them.
          Some data from external services may remain in logs, backups, generated output,
          or workspace records until ordinary retention or deletion processes remove it.
        </p>
      </>
    ),
  },
  {
    title: "Retention",
    content: (
      <>
        <p>
          We keep information for as long as needed to provide Matrix OS, maintain
          security, comply with legal obligations, resolve disputes, enforce terms, and
          support backup or recovery. Retention periods vary by data type, workspace
          lifecycle, backup schedule, and legal requirement.
        </p>
        <p>
          Deleting an account or workspace may not immediately remove information from
          backups, logs, analytics, or third-party systems, but those records are limited
          and removed or de-identified according to their normal lifecycle where feasible.
        </p>
      </>
    ),
  },
  {
    title: "Security",
    content: (
      <>
        <p>
          Matrix OS uses technical and organizational safeguards intended to protect the
          service, including authentication, isolated runtime design, scoped APIs, access
          controls, auditability, backups, logging, and operational monitoring.
        </p>
        <p>
          No online service can guarantee absolute security. You are responsible for
          protecting your account, reviewing connected integrations, and limiting what you
          choose to provide to AI agents or third-party services.
        </p>
      </>
    ),
  },
  {
    title: "Your Choices",
    content: (
      <>
        <p>
          Depending on where you live, you may have rights to request access, correction,
          deletion, export, restriction, objection, or withdrawal of consent for certain
          personal information. You can make privacy requests by emailing
          support@matrix-os.com.
        </p>
        <p>
          You can also control many data flows directly by changing workspace settings,
          disconnecting integrations, deleting files or app data, or choosing what context
          to give an AI task.
        </p>
      </>
    ),
  },
  {
    title: "Children",
    content: (
      <>
        <p>
          Matrix OS is not directed to children under 13, and we do not knowingly collect
          personal information from children under 13. If you believe a child provided us
          personal information, contact support@matrix-os.com.
        </p>
      </>
    ),
  },
  {
    title: "Changes",
    content: (
      <>
        <p>
          We may update this Privacy Policy as Matrix OS changes. The updated policy will
          include a new effective date. Material changes will apply prospectively unless
          required sooner for legal, security, or abuse-prevention reasons.
        </p>
      </>
    ),
  },
  {
    title: "Contact",
    content: (
      <>
        <p>
          Privacy questions or requests can be sent to Finna Labs Inc. at
          support@matrix-os.com.
        </p>
      </>
    ),
  },
] as const;

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="How Matrix OS handles account data, owner-controlled workspace data, analytics, integrations, AI providers, retention, and privacy requests."
      lastUpdated={lastUpdated}
      sections={sections}
    />
  );
}
