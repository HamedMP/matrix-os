// Vitest reporter for scripts/test-collaboration-postgres.sh. Writes the test
// states plus the module, suite-hook and unhandled errors the built-in JSON
// reporter drops, so a quarantined test failure cannot hide an afterAll error
// in the same file. The report path comes from COLLABORATION_POSTGRES_REPORT.

import { writeFile } from "node:fs/promises";

const MAX_ERROR_LENGTH = 500;

function describeError(error) {
  const message = String(error?.message ?? error ?? "unknown error").split("\n")[0];
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

export default class CollaborationPostgresReporter {
  async onTestRunEnd(testModules, unhandledErrors) {
    const reportPath = process.env.COLLABORATION_POSTGRES_REPORT;
    if (!reportPath) throw new Error("COLLABORATION_POSTGRES_REPORT is required");
    const report = {
      unhandledErrors: unhandledErrors.map(describeError),
      modules: testModules.map((testModule) => ({
        file: testModule.relativeModuleId,
        errors: [
          ...testModule.errors().map(describeError),
          ...[...testModule.children.allSuites()].flatMap((suite) =>
            suite.errors().map((error) => `${suite.fullName}: ${describeError(error)}`)),
        ],
        tests: [...testModule.children.allTests()].map((test) => ({
          name: test.fullName,
          state: test.result().state,
        })),
      })),
    };
    await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  }
}
