# Spec Status

Show progress across all specs.

## Steps

1. List all directories in `specs/`:
   ```
   ls -d specs/*/
   ```

2. For each spec directory, check for `tasks.md`:
   - Count `[X]` (completed) vs `[ ]` (pending) checkboxes
   - Read the spec name from `spec.md` or the directory name

3. Cross-reference with CLAUDE.md:
   - Which specs are listed under "Completed"?
   - Which are "In Progress"?
   - Which are "Next Up"?
   - Which are "Deferred"?

4. Build a status table sorted by spec number:
   ```
   | #   | Name                    | Done/Total | %   | Status      |
   |-----|-------------------------|------------|-----|-------------|
   | 003 | Architecture            | 56/56      | 100 | archived    |
   | 004 | Concurrent              | 4/4        | 100 | complete    |
   | 033 | Docs                    | 3/9        |  33 | in-progress |
   | 034 | Observability           | 0/30       |   0 | next-up     |
   ```

5. Summary stats:
   - Total specs: N
   - Completed: N (N tasks)
   - In progress: N (N/M tasks done)
   - Next up: N
   - Total tasks done: N / M

6. Highlight any specs that are partially done but not listed as "in progress" in CLAUDE.md (potential gaps).
