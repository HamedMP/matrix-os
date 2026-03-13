# Test Focus

Run tests for a specific package or feature area with failure analysis. Usage: `/test-focus <target>`

Target: $ARGUMENTS

## Steps

1. Resolve the target to test file(s):
   - **Package name** (kernel, gateway, platform, proxy, shell, www): map to `tests/<package>/`
   - **Feature keyword** (onboarding, channels, cron, hooks, social, dispatcher, etc.): grep test filenames and test descriptions to find matching files
   - **File path**: use directly
   - **No argument**: run all tests

2. Run the matched tests:
   ```
   vitest run <resolved-path> --reporter=verbose
   ```

3. If all pass: report count and duration. Done.

4. If any fail:
   - Read the failing test file
   - Read the corresponding source file
   - Analyze the failure: regression, missing mock, changed API, flaky timing, or genuine bug?
   - Present diagnosis with specific fix suggestions

5. Optionally run with coverage:
   ```
   vitest run <resolved-path> --coverage
   ```
   Report uncovered lines in the affected source files.

## Package-to-Path Mapping

- kernel -> tests/kernel/
- gateway -> tests/gateway/
- platform -> tests/platform/
- proxy -> tests/proxy/
- shell -> tests/shell/
- www -> tests/www/
- e2e -> vitest.e2e.config.ts
- integration -> vitest.integration.config.ts
