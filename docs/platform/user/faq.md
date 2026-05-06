# Frequently Asked Questions

## Account & Access

**How do I access my Matrix OS?**
Visit `https://{your-handle}.matrix-os.com`. If you chose the username "alice" during signup, your URL is `alice.matrix-os.com`.

**What happens when I'm not using it?**
Your Matrix OS keeps running on your own customer VPS. Platform routing sends your browser to that machine when you visit your URL. Your files, apps, and database state are preserved on the VPS and backed up through Matrix OS recovery flows.

**Can I use a custom domain?**
Not yet. All instances are hosted at `{handle}.matrix-os.com`.

**How do I change my handle?**
Handles are permanent and tied to your identity. Choose carefully during signup.

## Your AI Assistant

**Which AI model powers my assistant?**
Matrix OS uses Claude by Anthropic. Your assistant runs on the latest Claude model.

**Does my AI remember previous conversations?**
Yes. Your AI has persistent memory stored in your file system. It learns your preferences and builds on past interactions.

**Can my AI talk to other users' AIs?**
Yes. Matrix OS supports AI-to-AI communication via the Matrix protocol. Your AI can negotiate meetings, share data, and collaborate with other AIs (with your permission).

## Data & Privacy

**Where is my data stored?**
Your files live in your Matrix home on your customer VPS. Your app and workspace data lives in the Postgres database on that same VPS. Platform services store only control-plane records such as identity, routing, provisioning status, and integration metadata.

**Can I export my data?**
Yes. Your files are inspectable in your Matrix home, and app/workspace data is in your local Postgres database. Export and recovery flows use database snapshots plus file materialization where needed.

**Is my data encrypted?**
Traffic between your browser and Matrix OS is encrypted via HTTPS (Cloudflare TLS). End-to-end encryption for messaging is planned via the Matrix protocol.

## Technical

**What can I install?**
Your Matrix OS runs on a dedicated Linux VPS with a terminal, code editor, Node runtime, and bundled coding-agent CLIs. You can install packages on that VPS.

**What are the resource limits?**
Resources depend on the customer VPS size assigned to your plan. The default operator target is a small Hetzner VPS, and it can be resized or replaced through platform recovery workflows.

**Can I run my own Matrix OS?**
Yes. Matrix OS is open source. You can run it locally with Docker:
```bash
docker compose -f distro/docker-compose.local.yml up
```
