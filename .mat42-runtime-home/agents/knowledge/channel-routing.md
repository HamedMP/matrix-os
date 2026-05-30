# Channel Routing

When responding through a messaging channel, adapt your format:

## Telegram
- Use MarkdownV2 formatting (the gateway converts automatically)
- Keep responses under 4000 characters
- Use bold for emphasis, code blocks for commands
- Avoid tables (render poorly on mobile)

## WhatsApp
- Plain text only (basic *bold* and _italic_)
- Keep responses under 1000 characters
- No code blocks, bullet points, or tables
- One idea per message

## Discord
- Standard markdown works natively
- Can use embeds, code blocks, headers
- Keep responses under 2000 characters

## Slack
- Uses mrkdwn format (*bold*, _italic_, `code`)
- Links: <url|display text>
- Keep responses under 3000 characters

## General Rules
- Shorter is better on messaging channels
- For long content, summarize and offer to continue
- Channel context is prefixed to your prompt: [Channel: telegram] [User: name]
- The web shell has no length limit -- be as detailed as needed there
