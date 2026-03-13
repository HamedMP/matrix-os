# Update Documentation

After a major feature implementation, run this command to ensure all documentation is consistent and up to date.

## What to Check

Audit and update these locations in order:

### 1. CLAUDE.md (root)
- **Current State section**: update test count, test file count, completed phases
- **Active Specs**: ensure new specs are listed, completed ones archived
- **Architecture diagram**: update if new services/endpoints were added
- **Tech Stack**: update if new dependencies were added
- **Project Structure**: update if new packages/directories were added

### 2. Internal Dev Docs (`docs/dev/`)
- `docker-development.md`: Docker setup, profiles, scripts, env vars
- `vps-deployment.md`: production deployment changes
- `releases.md`: release process changes

### 3. Public Docs (`www/content/docs/`)
Check each section for accuracy:
- `guide/getting-started.mdx`: setup instructions, first-run experience
- `guide/agents.mdx`: agent system, onboarding, personas
- `guide/apps.mdx`: app manifest, building apps
- `guide/channels.mdx`: channel adapters, configuration
- `guide/file-system.mdx`: home directory structure
- `developer/architecture.mdx`: system architecture, provisioning pipeline
- `developer/contributing.mdx`: dev setup, testing, conventions
- `developer/ipc-tools.mdx`: IPC tool reference
- `developer/skills.mdx`: skill system

### 4. README.md
- Test count badge
- Feature list
- Quick start instructions

### 5. Specs
- Mark completed tasks/phases as done
- Update any referenced test counts or file paths

## How to Update

1. Run `bun run test` to get the current test count
2. Read each file listed above
3. Update outdated sections (test counts, feature lists, architecture, setup instructions)
4. Ensure cross-references between docs are correct (e.g., getting-started links to docker-development)
5. Do NOT create new documentation files unless a gap is critical
6. Keep updates minimal and focused -- only fix what's actually wrong

## Output

After updating, provide a summary table:

| File | Changes Made |
|------|-------------|
| ... | ... |
