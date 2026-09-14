# Matrix OS plugin

One package for Codex and Claude Code: 15 remote-computer MCP tools plus three
workflow skills. Both manifests load the same `.mcp.json` and `skills/` directory.

## Availability

Hosted Streamable HTTP is not yet live. Do not promote this HTTP-default package
until the endpoint and browser OAuth have passed the operator release gates in
`docs/dev/hosted-mcp.md` in the repository. Installing the package does not enable
the server. The separately authenticated CLI/stdio alternative remains available.

## Install after hosted rollout

Codex:

```sh
codex plugin marketplace add HamedMP/matrix-os
```

Open `/plugins`, choose the **Matrix OS** marketplace, and install `matrix-os`.
Start a new session and complete browser authentication for the bundled MCP
connection. In the desktop app, use the Plugins directory's marketplace picker.

Claude Code:

```text
/plugin marketplace add HamedMP/matrix-os
/plugin install matrix-os@matrix-os
```

Open `/mcp`, select the Matrix connection, and authenticate through your browser.
Start a new session after installation. Do not also add a manual Matrix MCP
connection unless you intentionally want duplicate tools.

Prefer tools without skills? Add `https://api.matrix-os.com/mcp` directly as a
Streamable HTTP server. See [Matrix MCP](https://matrix-os.com/docs/mcp).

## Permissions

The `matrix:computer` scope can run arbitrary commands, change files, control
terminals, and read chats on computers the signed-in account can access. Only
install into trusted clients. Never put tokens in configuration or chat. Matrix
rechecks access and runtime billing before issuing each gateway credential.

MCP does not disable the coding client's local shell. Set client permissions
separately for remote-only operation.

## Directory submission

This is Matrix's own marketplace, not a claim of an official directory listing.

- OpenAI: submit the live MCP server and skills through the
  [plugin submission portal](https://developers.openai.com/plugins/deploy/submission).
  The publisher needs a verified identity, submission write access, domain access,
  policy links, authentication details, and reproducible test cases.
- Claude: validate with `claude plugin validate`, then use the
  [plugin directory submission](https://claude.com/docs/plugins/submit) with the
  public repository and plugin path. Its MCP Connectors Directory is separate.

Submission and approval have not been completed. A maintainer must approve the
publisher identity, policy attestations, availability, and demo-account access;
do not include demo credentials in this repository.
