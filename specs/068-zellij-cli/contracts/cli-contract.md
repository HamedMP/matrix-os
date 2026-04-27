# CLI Contract: Unified `matrix`

## Command Tree

```text
matrix
|--- login [--platform URL] [--profile NAME] [--dev]
|--- logout [--profile NAME]
|--- whoami [--profile NAME] [--json]
|--- status [--profile NAME] [--json]
|--- doctor [--profile NAME] [--json]
|--- profile ls|show|use|set
|--- shell ls|new|attach|rm
|--- shell tab ls|new|go|close
|--- shell pane split|close
|--- shell layout ls|show|save|apply|rm
|--- sync start|stop|status|pause|resume|ls|push|pull
|--- ssh [handle]
|--- peers
|--- keys add|ls|rm
|--- instance info|restart|logs
`--- completion bash|zsh|fish
```

Aliases:

- `matrix sh` aliases `matrix shell`.
- `matrix shell attach` may also be exposed as `matrix shell connect`.
- `--dev` aliases `--profile local` without mutating the active profile.

## Global Flags

- `--profile <name>`
- `--platform <url>`
- `--gateway <url>`
- `--token <jwt>`
- `--json`
- `--no-color`
- `--quiet`
- `--verbose`
- `--dev`

## JSON Output

One-shot commands emit one JSON object on stdout:

```json
{
  "v": 1,
  "ok": true,
  "data": {}
}
```

Errors emit a JSON object to stderr and exit non-zero:

```json
{
  "v": 1,
  "error": {
    "code": "stable_code",
    "message": "Generic safe message"
  }
}
```

Streaming commands emit NDJSON:

```json
{ "v": 1, "type": "output", "data": { "bytes": "..." } }
```

## Profile Files

`~/.matrixos/profiles.json`:

```json
{
  "active": "cloud",
  "profiles": {
    "cloud": {
      "platformUrl": "https://app.matrix-os.com",
      "gatewayUrl": "https://app.matrix-os.com"
    },
    "local": {
      "platformUrl": "http://localhost:9000",
      "gatewayUrl": "http://localhost:4000"
    }
  }
}
```

Profile-scoped files:

```text
~/.matrixos/profiles/<name>/auth.json
~/.matrixos/profiles/<name>/config.json
~/.matrixos/profiles/<name>/cli.json
```

## Detach Behavior

`matrix shell attach <name>` and `matrix shell new <name>` attach interactively. The wrapper detach sequence is `Ctrl-\ Ctrl-\` by default and prints:

```text
Detached. Reattach: matrix shell attach <name>
```

The underlying session continues running.
