import type { Metadata } from "next";
import { LegalList, LegalPage } from "../legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | Matrix OS",
  description:
    "Terms of Service for Matrix OS, the AI-native cloud computer operated by Finna Labs Inc.",
  openGraph: {
    title: "Terms of Service | Matrix OS",
    description:
      "Terms for using Matrix OS, including hosted service rules, user data ownership, AI output, integrations, and open-source licensing.",
    url: "https://matrix-os.com/terms",
    siteName: "Matrix OS",
    type: "article",
  },
};

const lastUpdated = "May 28, 2026";

const sections = [
  {
    title: "Agreement",
    content: (
      <>
        <p>
          These Terms of Service govern access to Matrix OS, the website at matrix-os.com,
          hosted Matrix OS instances, related apps, APIs, support, and other services
          provided by Finna Labs Inc. By using Matrix OS, you agree to these terms.
        </p>
        <p>
          If you use Matrix OS for an organization, you confirm that you are allowed to
          accept these terms for that organization. If you do not agree, do not use the
          service.
        </p>
      </>
    ),
  },
  {
    title: "Service",
    content: (
      <>
        <p>
          Matrix OS is an AI-native operating environment that can provision a personal
          cloud computer, run apps, manage files and workspace state, connect approved
          integrations, and route requests through AI agents selected or configured by the
          user.
        </p>
        <p>
          Hosted Matrix OS workspaces may include control-plane services, per-user
          runtime infrastructure, generated software, terminal sessions, messaging or
          integration bridges, and backup or recovery systems. Some features are
          experimental, beta, or dependent on third-party providers.
        </p>
      </>
    ),
  },
  {
    title: "Accounts",
    content: (
      <>
        <p>
          You are responsible for the accuracy of account information, the security of
          your credentials, and all activity under your account. Tell us promptly at
          support@matrix-os.com if you believe your account or workspace has been
          compromised.
        </p>
        <p>
          You may not share access in a way that bypasses Matrix OS permissions, impersonate
          someone else, or interfere with another user&apos;s workspace.
        </p>
      </>
    ),
  },
  {
    title: "Your Data",
    content: (
      <>
        <p>
          As between you and Finna Labs Inc., you keep ownership of your prompts, files,
          app data, workspace data, generated apps, and other content you provide to or
          create with Matrix OS. You grant Finna Labs Inc. the limited rights needed to
          host, secure, operate, support, back up, transmit, and improve the service.
        </p>
        <p>
          Matrix OS is designed around owner-controlled data. Personal files live in your
          Matrix home, structured app and workspace records live in your Matrix database,
          and connected services are used only as authorized by you or your organization.
        </p>
      </>
    ),
  },
  {
    title: "AI Output",
    content: (
      <>
        <p>
          Matrix OS can generate text, code, app behavior, plans, commands, and other
          outputs through AI models and agents. AI output can be incomplete, unsafe,
          inaccurate, or unsuitable for your situation.
        </p>
        <p>
          You are responsible for reviewing, testing, and approving AI-generated output
          before relying on it, deploying it, sharing it, or using it for legal, medical,
          financial, security-sensitive, or other high-impact decisions.
        </p>
      </>
    ),
  },
  {
    title: "Use Rules",
    content: (
      <>
        <p>You agree not to use Matrix OS to:</p>
        <LegalList>
          <li>break the law or violate another person&apos;s rights;</li>
          <li>upload, generate, or distribute malware, exploit code, or abusive automation;</li>
          <li>attack, probe, overload, scrape, or disrupt Matrix OS or third-party systems;</li>
          <li>bypass access controls, rate limits, sandbox boundaries, or billing controls;</li>
          <li>connect third-party services without authorization; or</li>
          <li>store or process data you are not allowed to provide to the service.</li>
        </LegalList>
      </>
    ),
  },
  {
    title: "Integrations",
    content: (
      <>
        <p>
          When you connect services such as email, calendar, chat, repository hosting, or
          other integrations, you authorize Matrix OS and its integration providers to
          access those services as needed to perform the actions you request.
        </p>
        <p>
          Third-party services have their own terms and privacy practices. You are
          responsible for the permissions you grant and for disconnecting integrations you
          no longer want Matrix OS to use.
        </p>
      </>
    ),
  },
  {
    title: "Open Source",
    content: (
      <>
        <p>
          The Matrix OS source code is licensed under AGPL-3.0-or-later unless a file
          states otherwise. Those open-source license rights apply to the covered code and
          are not reduced by these service terms.
        </p>
        <p>
          These terms govern use of the hosted Matrix OS service, accounts, support,
          infrastructure, and related Finna Labs Inc. services. They do not transfer
          ownership of your content or generated apps to Finna Labs Inc.
        </p>
      </>
    ),
  },
  {
    title: "Payments",
    content: (
      <>
        <p>
          Some Matrix OS features may be free, usage-limited, invite-only, beta, or paid.
          If paid plans or usage charges apply, the checkout or order flow will describe
          the price, billing interval, taxes, cancellation terms, and any usage limits
          before you buy.
        </p>
        <p>
          You are responsible for third-party charges you choose to incur, including cloud,
          AI model, messaging, integration, or provider costs connected to your workspace.
        </p>
      </>
    ),
  },
  {
    title: "Changes",
    content: (
      <>
        <p>
          We may change, suspend, or discontinue features, especially beta or third-party
          dependent features. We may update these terms by posting a revised version with a
          new effective date. Material changes will apply prospectively unless the change
          is required sooner for legal, security, or abuse-prevention reasons.
        </p>
      </>
    ),
  },
  {
    title: "Disclaimers",
    content: (
      <>
        <p>
          Matrix OS is provided as is and as available. To the fullest extent permitted by
          law, Finna Labs Inc. disclaims warranties of merchantability, fitness for a
          particular purpose, non-infringement, uninterrupted availability, and error-free
          operation.
        </p>
        <p>
          To the fullest extent permitted by law, Finna Labs Inc. will not be liable for
          indirect, incidental, special, consequential, exemplary, or punitive damages, or
          for lost profits, lost data, lost goodwill, or service interruption.
        </p>
      </>
    ),
  },
  {
    title: "Contact",
    content: (
      <>
        <p>
          Questions about these terms can be sent to Finna Labs Inc. at
          support@matrix-os.com.
        </p>
      </>
    ),
  },
] as const;

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      description="The rules for using Matrix OS, including hosted workspaces, AI-generated output, integrations, and the AGPL-licensed open-source code."
      lastUpdated={lastUpdated}
      sections={sections}
    />
  );
}
