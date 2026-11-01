/* Isolated recipient fixture, not a product proof/authority constructor.
 * fd3 is inherited control. Kernel identity never comes from payload bytes. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int alive(int fd) {
  struct pollfd p = {.fd = fd, .events = POLLIN};
  return poll(&p, 1, 0) == 0 && !p.revents;
}
static int fd_count(void) {
  DIR *dir = opendir("/proc/self/fd"); if (!dir) return -1;
  int count = 0; struct dirent *entry;
  while ((entry = readdir(dir))) if (entry->d_name[0] != '.') count++;
  closedir(dir); return count;
}
static int kernel_pid(int fd, int *pid) {
  char path[64], target[64], line[256];
  snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
  ssize_t n = readlink(path, target, sizeof(target) - 1);
  if (n < 0) return -1;
  target[n] = 0; if (strcmp(target, "anon_inode:[pidfd]")) return -1;
  snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", fd);
  FILE *file = fopen(path, "r"); if (!file) return -1;
  int found = 0, lines = 0;
  while (lines++ < 16 && fgets(line, sizeof(line), file)) {
    if (sscanf(line, "Pid:\t%d", pid) == 1) { found = 1; break; }
  }
  fclose(file); return found ? 0 : -1;
}
static int inspect(int proof) {
  int pid, flags = fcntl(proof, F_GETFD);
  if (flags < 0 || kernel_pid(proof, &pid)) return -1;
  printf("{\"event\":\"proof\",\"kernelPid\":%d,\"alive\":%s,\"cloexec\":%s,\"fds\":%d}\n", pid, alive(proof) ? "true" : "false", (flags & FD_CLOEXEC) ? "true" : "false", fd_count());
  fflush(stdout); return 0;
}
static int receive_proof(int parent_birth, pid_t parent, int *proof) {
  if (!alive(parent_birth)) return -1;
  struct pollfd p = {.fd = 3, .events = POLLIN};
  int ready = poll(&p, 1, 150);
  if (!ready) { puts("{\"event\":\"idle\"}"); fflush(stdout); return 0; }
  if (ready < 0) return -1;
  char bytes[8192];
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(256 * sizeof(int))]; } control;
  struct iovec vector = {bytes, sizeof(bytes)}; struct msghdr message = {0};
  message.msg_iov = &vector; message.msg_iovlen = 1;
  message.msg_control = control.bytes; message.msg_controllen = sizeof(control.bytes);
  ssize_t length = recvmsg(3, &message, MSG_CMSG_CLOEXEC);
  if (length <= 0) return -1;
  int invalid = !!(message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)), credentials = 0;
  int delivered[256], count = 0; struct ucred writer = {0};
  for (struct cmsghdr *h = CMSG_FIRSTHDR(&message); h; h = CMSG_NXTHDR(&message, h)) {
    if (h->cmsg_level == SOL_SOCKET && h->cmsg_type == SCM_RIGHTS && h->cmsg_len >= CMSG_LEN(0)) {
      size_t rights = (h->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *fds = (int *)CMSG_DATA(h);
      for (size_t i = 0; i < rights; i++) {
        if (count < 256) delivered[count++] = fds[i];
        else { close(fds[i]); invalid = 1; }
      }
    } else if (h->cmsg_level == SOL_SOCKET && h->cmsg_type == SCM_CREDENTIALS && h->cmsg_len == CMSG_LEN(sizeof(writer))) {
      memcpy(&writer, CMSG_DATA(h), sizeof(writer)); credentials++;
    } else invalid = 1;
  }
  int pid = 0;
  if (invalid || credentials != 1 || count != 1 || *proof >= 0 || writer.pid != parent
      || writer.uid != getuid() || writer.gid != getgid() || !alive(parent_birth)
      || kernel_pid(delivered[0], &pid)) {
    for (int i = 0; i < count; i++) close(delivered[i]);
    return -1;
  }
  *proof = delivered[0];
  printf("{\"event\":\"received\",\"rights\":%d,\"writer\":{\"pid\":%d,\"uid\":%u,\"gid\":%u},\"parentAlive\":true,\"bytes\":%zd,\"hex\":\"", count, writer.pid, writer.uid, writer.gid, length);
  for (ssize_t i = 0; i < length; i++) printf("%02x", (unsigned char)bytes[i]);
  puts("\"}"); fflush(stdout); return inspect(*proof);
}
int main(void) {
  /* Retain kernel parent before reading any control bytes or test command. */
  pid_t parent = getppid(); if (parent <= 1) return 20;
  int parent_birth = (int)syscall(SYS_pidfd_open, parent, 0), proof = -1, result = 0;
  if (parent_birth < 0 || fcntl(parent_birth, F_SETFD, FD_CLOEXEC) || !alive(parent_birth)) return 21;
  printf("{\"event\":\"start\",\"parent\":%d,\"fds\":%d}\n", parent, fd_count()); fflush(stdout);
  char line[128];
  while (fgets(line, sizeof(line), stdin)) {
    size_t length = strlen(line);
    if (!length || line[length - 1] != '\n') { result = 22; break; }
    line[length - 1] = 0;
    if (!strcmp(line, "receive")) { if (receive_proof(parent_birth, parent, &proof)) { result = 23; break; } }
    else if (!strcmp(line, "inspect")) { if (proof < 0 || inspect(proof)) { result = 24; break; } }
    else if (!strcmp(line, "drop")) {
      if (proof >= 0) close(proof);
      proof = -1; printf("{\"event\":\"dropped\",\"fds\":%d}\n", fd_count()); fflush(stdout);
    } else if (!strcmp(line, "exit")) break;
    else { result = 25; break; }
    fputs("ack\n", stderr); fflush(stderr);
  }
  if (proof >= 0) close(proof);
  close(parent_birth); close(3); return result;
}
