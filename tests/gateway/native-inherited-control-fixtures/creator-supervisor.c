/* Fixed Linux lifetime fixture, not a product identity/authority protocol.
 * All pidfds originate from actual self/fork returns, never a received PID.
 * Gated children cannot exec/spawn descendants until their owner proof is held. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <time.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#ifndef SCM_PIDFD
#define SCM_PIDFD 4
#endif
typedef struct { uint32_t tag; int32_t pid; } wire;
static long long end;
static long long now_ms(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(95); return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static int live(int fd) { struct pollfd p = {.fd = fd, .events = POLLIN}; return fd >= 0 && poll(&p, 1, 0) == 0 && !p.revents; }
static int ready(int fd, short events, long long until) {
  while (now_ms() < until) {
    struct pollfd p = {.fd = fd, .events = events};
    int ms = (int)(until - now_ms()); if (ms > 100) ms = 100; if (ms < 0) ms = 0;
    int n = poll(&p, 1, ms);
    if (n > 0 && now_ms() < until) return 1;
    if (n < 0 && errno != EINTR) return 0;
  }
  return 0;
}
static int pair(int fds[2]) {
  int enabled = 1;
  return socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) == 0
    && setsockopt(fds[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) == 0
    && setsockopt(fds[1], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) == 0;
}
static int retain(pid_t actual) {
  int fd = (int)syscall(SYS_pidfd_open, actual, 0);
  if (fd < 0 || !(fcntl(fd, F_GETFD) & FD_CLOEXEC) || !live(fd)) { if (fd >= 0) close(fd); return -1; }
  return fd;
}
static int pidfd_type(int fd) { return fd >= 3 && (fcntl(fd, F_GETFD) & FD_CLOEXEC) && syscall(SYS_pidfd_send_signal, fd, 0, NULL, 0) == 0 && live(fd); }
static int signal_owned(int fd) { return fd < 0 || !live(fd) || syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0) == 0; }
static int wait_owned(int fd, long long until, int *code) {
  while (now_ms() < until) {
    siginfo_t info = {0};
    if (waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOHANG) == 0) {
      if (info.si_pid) { *code = info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status; return 1; }
    } else if (errno == ECHILD) return 2; /* Already waited by its actual relay, not a fabricated exit. */
    else if (errno != EINTR) return 0;
    if (!ready(fd, POLLIN, until)) return 0;
  }
  return 0;
}
/* Close ALL delivered known descriptor types before any rejected/late return. */
static ssize_t receive(int fd, pid_t expected, int held_peer, void *data, size_t size, int want_fd, int *owned) {
  if (!ready(fd, POLLIN, end)) return -1;
  union { struct cmsghdr align; char data[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(256 * sizeof(int))]; } control;
  struct iovec v = {data, size}; struct msghdr m = {0}; m.msg_iov = &v; m.msg_iovlen = 1; m.msg_control = control.data; m.msg_controllen = sizeof(control.data);
  ssize_t n = recvmsg(fd, &m, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  if (n < 0) return -1;
  int fds[256], count = 0, rights = 0, creds = 0, invalid = !!(m.msg_flags & (MSG_CTRUNC | MSG_TRUNC)); struct ucred writer = {0};
  for (struct cmsghdr *h = CMSG_FIRSTHDR(&m); h; h = CMSG_NXTHDR(&m, h)) {
    if (h->cmsg_level == SOL_SOCKET && (h->cmsg_type == SCM_RIGHTS || h->cmsg_type == SCM_PIDFD)) {
      if (h->cmsg_type == SCM_RIGHTS) rights++;
      if (h->cmsg_len >= CMSG_LEN(0)) {
        size_t total = (h->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *values = (int *)CMSG_DATA(h);
        if (h->cmsg_type == SCM_PIDFD) { invalid = 1; if (total > 1) total = 1; }
        for (size_t i = 0; i < total; i++) { if (count < 256) fds[count++] = values[i]; else { close(values[i]); invalid = 1; } }
      }
    } else if (h->cmsg_level == SOL_SOCKET && h->cmsg_type == SCM_CREDENTIALS && h->cmsg_len == CMSG_LEN(sizeof(writer))) {
      memcpy(&writer, CMSG_DATA(h), sizeof(writer)); creds++;
    } else invalid = 1;
  }
  invalid |= n <= 0 || now_ms() >= end || creds != 1 || writer.pid != expected || writer.uid != getuid() || writer.gid != getgid()
    || count != want_fd || rights != want_fd || (held_peer >= 0 && !live(held_peer));
  if (invalid) { for (int i = 0; i < count; i++) close(fds[i]); return -1; }
  if (want_fd) *owned = fds[0];
  return n;
}
static int transfer(int fd, char tag, pid_t actual, int owned) {
  wire value = {(uint32_t)tag, (int32_t)actual};
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct iovec v = {&value, sizeof(value)}; struct msghdr m = {0}; m.msg_iov = &v; m.msg_iovlen = 1; m.msg_control = control.bytes; m.msg_controllen = sizeof(control.bytes);
  struct cmsghdr *h = CMSG_FIRSTHDR(&m); h->cmsg_level = SOL_SOCKET; h->cmsg_type = SCM_RIGHTS; h->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(h), &owned, sizeof(owned));
  return ready(fd, POLLOUT, end) && sendmsg(fd, &m, MSG_DONTWAIT | MSG_NOSIGNAL) == (ssize_t)sizeof(value) && now_ms() < end;
}
static int take(int fd, pid_t peer, int peer_proof, char tag, int *owned, pid_t *actual) {
  wire value = {0}; int received = -1;
  if (receive(fd, peer, peer_proof, &value, sizeof(value), 1, &received) != (ssize_t)sizeof(value) || value.tag != (uint32_t)tag) {
    if (received >= 0) close(received);
    return 0;
  }
  *owned = received;
  if (actual) *actual = value.pid;
  return 1;
}
static int send_bytes(int fd, const char *bytes) {
  size_t left = strlen(bytes);
  while (left) {
    if (!ready(fd, POLLOUT, end)) return 0;
    ssize_t n = send(fd, bytes, left, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (n <= 0 || now_ms() >= end) return 0;
    bytes += n; left -= (size_t)n;
  }
  return 1;
}
static int ack(int fd, pid_t peer, int proof) { char byte = 0; return receive(fd, peer, proof, &byte, 1, 0, NULL) == 1 && byte == 'A'; }
static int line(int fd, pid_t peer, int proof, char tag, char output[4096]) {
  size_t length = 0;
  while (length < 4095) {
    char c; if (receive(fd, peer, proof, &c, 1, 0, NULL) != 1) return 0;
    if (c == '\n') { output[length] = 0; return length > 2 && output[0] == tag && output[1] == ' '; }
    output[length++] = c;
  }
  return 0;
}
static int gate(int fd) { char c; return ready(fd, POLLIN, end) && read(fd, &c, 1) == 1 && c == 'G'; }
static int connected(int fd) {
  struct pollfd p = {.fd = fd, .events = POLLRDHUP};
  return fd >= 0 && poll(&p, 1, 0) >= 0 && !(p.revents & (POLLHUP | POLLRDHUP | POLLERR | POLLNVAL));
}
static void exec_service(const char *node, const char *script, const char *addon, int control, int channel, int start) {
  if (!gate(start)) _exit(91);
  int a = fcntl(control, F_DUPFD_CLOEXEC, 10), b = fcntl(channel, F_DUPFD_CLOEXEC, 10);
  if (a < 0 || b < 0 || dup2(a, 0) < 0 || dup2(a, 1) < 0 || dup2(b, 3) < 0 || syscall(SYS_close_range, 4u, ~0u, 0u)) _exit(92);
  execl(node, node, script, addon, (char *)NULL); _exit(93);
}
static void relay_role(const char *node, const char *script, const char *addon, int control, int command, int super_proof, pid_t super, int start) {
  int channel[2] = {-1, -1}, launch[2] = {-1, -1}, birth = -1, code = -1, rc = 90;
  pid_t actual = -1; char record[4096], outbound[4608];
  if (!gate(start) || !pair(channel) || pipe2(launch, O_CLOEXEC)) goto done;
  actual = fork();
  if (!actual) { close(launch[1]); close(channel[0]); exec_service(node, script, addon, control, channel[1], launch[0]); }
  if (actual < 0) goto done;
  close(launch[0]); launch[0] = -1; close(channel[1]); channel[1] = -1;
  birth = retain(actual);
  if (birth < 0 || !transfer(command, 'S', actual, birth) || !ack(command, super, super_proof)) goto done;
  if (write(launch[1], "G", 1) != 1) goto done;
  close(launch[1]); launch[1] = -1;
  if (!line(channel[0], actual, birth, 'R', record)) goto done;
  snprintf(outbound, sizeof(outbound), "R {\"serviceBirthLive\":true,\"actualServicePID\":%d,\"payload\":%s}\n", actual, record + 2);
  if (!send_bytes(command, outbound)) goto done;
  const char *commands[] = {"CHECK\n", "PING\n", "EXIT\n"}; const char tags[] = {'C', 'P', 'E'};
  for (int i = 0; i < 3; i++) {
    char token[16]; size_t n = 0;
    do { if (n >= sizeof(token) - 1 || receive(command, super, super_proof, token + n, 1, 0, NULL) != 1) goto done; } while (token[n++] != '\n');
    token[n] = 0; if (strcmp(token, commands[i]) || !send_bytes(channel[0], commands[i])) goto done;
    if (i < 2) {
      if (!line(channel[0], actual, birth, tags[i], record)) goto done;
      snprintf(outbound, sizeof(outbound), "%c {\"serviceBirthLive\":true,\"payload\":%s}\n", tags[i], record + 2);
      if (!send_bytes(command, outbound)) goto done;
    } else {
      if (wait_owned(birth, end, &code) != 1 || live(birth)) goto done;
      snprintf(outbound, sizeof(outbound), "E {\"serviceWaited\":true,\"serviceExitCode\":%d,\"serviceBirthDead\":true}\n", code);
      if (!send_bytes(command, outbound)) goto done;
    }
  }
  rc = code == 0 ? 0 : 90;
done:
  if (launch[1] >= 0) close(launch[1]);
  if (birth >= 0) { signal_owned(birth); wait_owned(birth, now_ms() + 2000, &code); close(birth); }
  _exit(rc);
}
static void creator_role(const char *node, const char *script, const char *addon, int bridge, int command, int super_proof, pid_t super) {
  int control[2] = {-1, -1}, launch[2] = {-1, -1}, birth = -1, code = -1;
  if (!pair(control) || !transfer(bridge, 'H', 0, control[0]) || !ack(bridge, super, super_proof) || pipe2(launch, O_CLOEXEC)) goto bad;
  pid_t actual = fork();
  if (!actual) { close(launch[1]); close(control[0]); close(bridge); relay_role(node, script, addon, control[1], command, super_proof, super, launch[0]); }
  if (actual < 0) goto bad;
  close(launch[0]); launch[0] = -1; close(control[1]); control[1] = -1; close(command);
  birth = retain(actual);
  if (birth < 0 || !transfer(bridge, 'R', actual, birth) || !ack(bridge, super, super_proof) || write(launch[1], "G", 1) != 1) goto bad;
  close(launch[1]); launch[1] = -1;
  char q; if (receive(bridge, super, super_proof, &q, 1, 0, NULL) != 1 || q != 'Q') goto bad;
  if (!send_bytes(control[0], "queued-by-real-creator") || !send_bytes(bridge, "W")) goto bad;
  _exit(0); /* Supervisor owns opposite copy before this actual creator dies. */
bad:
  if (launch[1] >= 0) close(launch[1]);
  if (birth >= 0) { signal_owned(birth); wait_owned(birth, now_ms() + 2000, &code); }
  _exit(90);
}
int main(int argc, char **argv) {
  int bridge[2] = {-1, -1}, command[2] = {-1, -1}, self = -1, creator = -1, relay = -1, service = -1, holder = -1;
  int creator_code = -1, relay_code = -1, service_code = -1, ok = 0, children_clear = 0, creator_waited = 0, relay_waited = 0;
  int creator_dead = 0, no_hup = 0, relay_live = 0, service_live = 0, queued = 0; pid_t actual_creator = -1, actual_relay = -1, actual_service = -1;
  char ready_record[4096] = "R {}", check_record[4096] = "C {}", ping_record[4096] = "P {}", exit_record[4096] = "E {}";
  const char *phase = "prerequisite"; end = now_ms() + 12000; signal(SIGPIPE, SIG_IGN);
  if (argc != 4 || getuid() == 0 || getpid() <= 1 || getpgrp() != getpid() || prctl(PR_SET_CHILD_SUBREAPER, 1) || !pair(bridge) || !pair(command)) goto done;
  self = retain(getpid()); if (self < 0) goto done;
  actual_creator = fork();
  if (!actual_creator) { close(bridge[0]); close(command[0]); creator_role(argv[1], argv[2], argv[3], bridge[1], command[1], self, getppid()); }
  if (actual_creator < 0) goto done;
  close(bridge[1]); bridge[1] = -1; close(command[1]); command[1] = -1;
  creator = retain(actual_creator); if (creator < 0) goto done;
  phase = "creator-transfer";
  if (!take(bridge[0], actual_creator, creator, 'H', &holder, NULL) || !send_bytes(bridge[0], "A")) goto done;
  int family, type; socklen_t size = sizeof(int);
  if (getsockopt(holder, SOL_SOCKET, SO_DOMAIN, &family, &size) || family != AF_UNIX) goto done;
  size = sizeof(int); if (getsockopt(holder, SOL_SOCKET, SO_TYPE, &type, &size) || type != SOCK_STREAM) goto done;
  if (!take(bridge[0], actual_creator, creator, 'R', &relay, &actual_relay) || !pidfd_type(relay) || !send_bytes(bridge[0], "A")) goto done;
  phase = "relay-transfer";
  if (!take(command[0], actual_relay, relay, 'S', &service, &actual_service) || !pidfd_type(service) || !send_bytes(command[0], "A")) goto done;
  if (!line(command[0], actual_relay, relay, 'R', ready_record)) goto done;
  phase = "actual-creator-exit";
  if (!send_bytes(bridge[0], "Q")) goto done;
  char w; if (receive(bridge[0], actual_creator, -1, &w, 1, 0, NULL) != 1 || w != 'W') goto done;
  queued = 1;
  creator_waited = wait_owned(creator, end, &creator_code) == 1; creator_dead = !live(creator);
  no_hup = connected(holder); relay_live = live(relay); service_live = live(service);
  if (!creator_waited || creator_code != 0 || !creator_dead || !no_hup || !relay_live || !service_live) goto done;
  phase = "first-current-after-death";
  if (!send_bytes(command[0], "CHECK\n") || !line(command[0], actual_relay, relay, 'C', check_record)
      || !send_bytes(command[0], "PING\n") || !line(command[0], actual_relay, relay, 'P', ping_record)) goto done;
  phase = "owned-exits";
  if (!send_bytes(command[0], "EXIT\n") || !line(command[0], actual_relay, -1, 'E', exit_record)) goto done;
  relay_waited = wait_owned(relay, end, &relay_code) == 1;
  if (!relay_waited || relay_code != 0 || live(service)) goto done;
  ok = 1;
done:
  /* Release every parent-held gate channel before waiting: a child whose birth
   * acquisition failed must observe EOF and exit while this parent still owns it. */
  for (int i = 0; i < 2; i++) {
    if (bridge[i] >= 0) { close(bridge[i]); bridge[i] = -1; }
    if (command[i] >= 0) { close(command[i]); command[i] = -1; }
  }
  signal_owned(service); signal_owned(relay); signal_owned(creator);
  long long cleanup_end = now_ms() + 4000;
  if (creator >= 0 && !creator_waited) creator_waited = wait_owned(creator, cleanup_end, &creator_code) == 1;
  if (relay >= 0 && !relay_waited) relay_waited = wait_owned(relay, cleanup_end, &relay_code) == 1;
  if (service >= 0) wait_owned(service, cleanup_end, &service_code);
  /* Unknown pre-ACK children are still gated: parent death closes their sole
   * start writer, so they exit. Reap only actual adopted children, never scan. */
  while (now_ms() < cleanup_end) {
    int status; pid_t child = waitpid(-1, &status, WNOHANG);
    if (child < 0 && errno == ECHILD) { children_clear = 1; break; }
    if (!child) { struct pollfd nothing = {.fd = -1}; poll(&nothing, 1, 10); }
    if (child < 0 && errno != EINTR) break;
  }
  int dead = (creator < 0 || !live(creator)) && (relay < 0 || !live(relay)) && (service < 0 || !live(service));
  int fds[] = {self, creator, relay, service, holder, bridge[0], bridge[1], command[0], command[1]};
  for (unsigned int i = 0; i < sizeof(fds) / sizeof(fds[0]); i++) if (fds[i] >= 0) close(fds[i]);
  printf("{\"scope\":\"actual fork-owned creator death; fixture observations not source authority\",\"sourceEnabled\":false,\"accountQualified\":false,\"transportComplete\":%s,\"phase\":\"%s\",\"actualCreatorPID\":%d,\"actualRelayPID\":%d,\"actualServicePID\":%d,\"genuineBytesQueued\":%s,\"creatorWaited\":%s,\"creatorExitCode\":%d,\"creatorPidfdDead\":%s,\"oppositeEndpointNoHupBeforeCheck\":%s,\"relayLiveBeforeCheck\":%s,\"serviceLiveBeforeCheck\":%s,\"ready\":%s,\"observation\":%s,\"ping\":%s,\"serviceExit\":%s,\"relayWaited\":%s,\"relayExitCode\":%d,\"allBirthsDead\":%s,\"allChildrenActuallyReaped\":%s}\n",
    ok ? "true" : "false", phase, actual_creator, actual_relay, actual_service, queued ? "true" : "false", creator_waited ? "true" : "false", creator_code, creator_dead ? "true" : "false", no_hup ? "true" : "false", relay_live ? "true" : "false", service_live ? "true" : "false", ready_record + 2, check_record + 2, ping_record + 2, exit_record + 2, relay_waited ? "true" : "false", relay_code, dead ? "true" : "false", children_clear ? "true" : "false");
  return ok && dead && children_clear ? 0 : 1;
}
