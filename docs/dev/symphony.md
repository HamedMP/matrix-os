# Symphony Local Runner

Matrix OS runs Symphony as a local per-instance service. The current internal
implementation lives in the private `FinnaAI/symphony` repository; Matrix OS
does not vendor that Elixir service in this repo.

## Install

```bash
git clone git@github.com:FinnaAI/symphony.git ~/code/symphony
cd ~/code/symphony/elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
```

## Run From Matrix OS

Set a local Linear key in the Matrix gateway environment:

```bash
LINEAR_API_KEY=...
```

Then open the Symphony app in Matrix OS. It uses the gateway's local
`/api/symphony/*` runner endpoints to start the Elixir service beside the
current Matrix instance.

Default runner contract:

- Symphony checkout: `~/code/symphony/elixir`
- Runner binary: `./bin/symphony`
- Workflow: `WORKFLOW.md` in the Matrix OS process working directory
- Dashboard: `http://127.0.0.1:4066`

## Ticket Source

Today the Matrix internal workflow watches Linear:

- Team key: `MAT`
- Required label: `symphony`
- Active states: `Todo`, `In Progress`, `Merging`, `Rework`

Tickets without the `symphony` label are intentionally ignored. The long-term
product shape is tracker adapters per Matrix instance: Linear for the internal
team, GitHub Issues or a Matrix-native ticket board for other instances.
