/* Test-only acquisition fault wrapper. Include a disposable actor copy whose
 * ONLY changed call is creator=fixture_fail_creator_retain(actual_creator).
 * The original report stays untouched. Safety cleanup is separate evidence. */
#define _GNU_SOURCE
#include <sys/types.h>
#include <errno.h>
static pid_t injected_creator = -1;
static unsigned injected_calls;
static int fixture_fail_creator_retain(pid_t actual) {
  injected_creator = actual; injected_calls++;
  errno = EMFILE;
  return -1;
}
#ifndef CREATOR_SUPERVISOR_FAULT_SOURCE
#error "compile with the exact parent-generated fault actor source path"
#endif
#define main fixture_main
#include CREATOR_SUPERVISOR_FAULT_SOURCE
#undef main

int main(int argc, char **argv) {
  int original_code = fixture_main(argc, argv);
  /* The same actual parent remains alive here. Only waitpid==0 permits a
   * numeric signal: this known direct, unreaped child's PID cannot be reused.
   * ECHILD never signals, and no received PID or descendant scan is used. */
  int safety_used = 0, kill_attempted = 0, reaped = 0, no_child = 0;
  int safety_code = -1, safety_error = 0, status = 0;
  long long safety_end = now_ms() + 1500;
  if (injected_calls == 1 && injected_creator > 1) {
    while (now_ms() < safety_end) {
      pid_t actual = waitpid(injected_creator, &status, WNOHANG);
      if (actual == injected_creator) {
        safety_used = 1; reaped = 1;
        safety_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        break;
      }
      if (actual < 0) {
        if (errno == ECHILD) no_child = 1;
        else if (errno == EINTR) continue;
        else safety_error = errno;
        break;
      }
      if (!kill_attempted) {
        safety_used = 1; kill_attempted = 1;
        if (kill(injected_creator, SIGKILL) && errno != ESRCH) { safety_error = errno; break; }
      }
      struct pollfd nothing = {.fd = -1}; poll(&nothing, 1, 5);
    }
  }
  int complete = injected_calls == 1 && injected_creator > 1 && !safety_error && (reaped || no_child);
  printf("{\"event\":\"wrapper-safety\",\"fixtureOnly\":true,\"injectedCalls\":%u,\"forcedEMFILE\":%s,\"actualForkReturnedCreatorPID\":%d,\"originalExitCode\":%d,\"safetyCleanupUsed\":%s,\"safetyKillAttempted\":%s,\"safetyWaitReaped\":%s,\"safetyNoChild\":%s,\"safetyExitCode\":%d,\"safetyError\":%d,\"safetyComplete\":%s}\n",
    injected_calls, injected_calls == 1 ? "true" : "false", injected_creator, original_code,
    safety_used ? "true" : "false", kill_attempted ? "true" : "false", reaped ? "true" : "false", no_child ? "true" : "false", safety_code, safety_error, complete ? "true" : "false");
  return complete ? original_code : 97;
}
