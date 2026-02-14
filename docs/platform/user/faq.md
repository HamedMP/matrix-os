# Frequently Asked Questions

## Account & Access

**How do I access my Matrix OS?**
Visit `https://{your-handle}.matrix-os.com`. If you chose the username "alice" during signup, your URL is `alice.matrix-os.com`.

**What happens when I'm not using it?**
Your instance automatically sleeps after 30 minutes of inactivity. When you visit your URL again, it wakes up in a few seconds. Your files and settings are preserved.

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
Your files are stored in a persistent volume on the Matrix OS servers. Each user gets an isolated container -- your data is not shared with other users.

**Can I export my data?**
Yes. Everything in Matrix OS is a file. You can use the terminal to archive and download your entire file system.

**Is my data encrypted?**
Traffic between your browser and Matrix OS is encrypted via HTTPS (Cloudflare TLS). End-to-end encryption for messaging is planned via the Matrix protocol.

## Technical

**What can I install?**
Your instance runs in a Docker container with a full Linux environment. You have access to a terminal and can install packages.

**What are the resource limits?**
Each instance gets 256MB of memory and 0.5 CPU cores. These limits may be adjusted based on your plan.

**Can I run my own Matrix OS?**
Yes. Matrix OS is open source. You can run it locally with Docker:
```bash
docker compose -f distro/docker-compose.local.yml up
```
