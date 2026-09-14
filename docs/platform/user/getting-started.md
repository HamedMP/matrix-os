# Getting Started with Matrix OS

Matrix OS is an AI-native operating system that runs in the cloud. Open it at `app.matrix-os.com`; the platform uses your signed-in session to route you to your own Matrix VPS with a full desktop environment, AI assistant, and file system.

## Create Your Account

1. Visit [matrix-os.com](https://matrix-os.com)
2. Click **Get Started**
3. Choose a username -- this becomes your Matrix handle and identity label
4. Complete the signup process

Your Matrix OS instance is automatically provisioned. This takes about 30 seconds.

## Access Your Instance

Once provisioned, visit:

```
https://app.matrix-os.com
```

You'll see the Matrix OS desktop with:
- **Chat panel** -- talk to your AI assistant
- **File browser** -- your persistent file system
- **Terminal** -- full shell access
- **App viewer** -- run and build apps

## Your Identity

Every Matrix OS user gets a federated identity:

- **Your handle**: `@{username}:matrix-os.com`
- **Your AI**: `@{username}_ai:matrix-os.com`

Your AI assistant has its own identity and can communicate with other users' AIs.

## Dashboard

Visit [matrix-os.com/dashboard](https://matrix-os.com/dashboard) to:
- See your instance status (running/stopped)
- Quick-link to your Matrix OS desktop
- View your usage

## Auto Sleep/Wake

To save resources, your instance can be recovered or refreshed by the platform when needed. When you visit `app.matrix-os.com`, the platform routes your signed-in session to your active customer VPS.

## What You Can Do

### Talk to Your AI
Open the chat panel and describe what you need. Your AI can:
- Create files and applications
- Browse the web and research topics
- Manage your schedule and tasks
- Build custom tools and automations

### Build Apps
Describe an app in natural language and your AI builds it. Apps persist in your file system and can be shared.

### Connect Channels
Connect your Matrix OS to messaging platforms:
- Telegram
- Discord
- Slack
- WhatsApp

Configure channels in your system settings.

### Connect X

Open **Settings > Integrations**, find **X**, and select **Connect**. The same
connection is then available to the Matrix assistant and supported coding
agents through the managed integrations boundary. Ask the agent to describe
the `twitter` service before first use to see its approved actions.

Matrix supports reading the connected profile, looking up a user, listing a
user's posts, searching posts from the last seven days, and publishing a text
post or reply. Publishing is classified as a write action and requires an
explicit user request.

The Pipedream X connector asks for credentials from an X developer app. Create
the app in the [X Developer Console](https://developer.x.com/en/portal/dashboard),
enable read and write access, and use the callback URL shown by Pipedream. X API
calls use [pay-per-use credits](https://docs.x.com/x-api/getting-started/pricing),
so set an appropriate spending limit before connecting a production account.
Provider credentials remain with Pipedream; Matrix stores only the
connected-account reference.

### Social Features
- View other Matrix OS users
- Send messages between instances
- Your AI can communicate with other AIs
