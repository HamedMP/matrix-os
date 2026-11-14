/* Isolated transport actor: fd3 is inherited control, stdin commands are tests.
 * No supplied body field selects an expected writer or grants authority. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>

static int output(const char *bytes, size_t length) {
  while (length) {
    ssize_t n = send(3, bytes, length, MSG_NOSIGNAL);
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    if (!n) return -1;
    bytes += n; length -= (size_t)n;
  }
  return 0;
}
static int rights(int count) {
  int fds[253]; for (int i = 0; i < count; i++) fds[i] = 0;
  union { struct cmsghdr align; char bytes[CMSG_SPACE(253 * sizeof(int))]; } control;
  struct iovec vector = {(void *)"rights", 6}; struct msghdr message = {0};
  message.msg_iov = &vector; message.msg_iovlen = 1;
  message.msg_control = control.bytes; message.msg_controllen = CMSG_SPACE((size_t)count * sizeof(int));
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN((size_t)count * sizeof(int));
  memcpy(CMSG_DATA(header), fds, (size_t)count * sizeof(int));
  return sendmsg(3, &message, MSG_NOSIGNAL) < 0 ? -1 : 0;
}
static int parent_alive(int birth) {
  struct pollfd p = {.fd = birth, .events = POLLIN};
  return poll(&p, 1, 0) == 0 && !p.revents;
}
static int receive_parent(int birth) {
  struct pollfd p = {.fd = 3, .events = POLLIN};
  if (poll(&p, 1, 2000) <= 0) return -1;
  char bytes[256]; union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(struct ucred))]; } control;
  struct iovec vector = {bytes, sizeof(bytes)}; struct msghdr message = {0};
  message.msg_iov = &vector; message.msg_iovlen = 1;
  message.msg_control = control.bytes; message.msg_controllen = sizeof(control.bytes);
  ssize_t length = recvmsg(3, &message, MSG_CMSG_CLOEXEC);
  if (length < 0 || (message.msg_flags & (MSG_CTRUNC | MSG_TRUNC))) return -1;
  if (!length) { puts("{\"event\":\"eof\"}"); fflush(stdout); return 0; }
  int credentials = 0; struct ucred writer = {0};
  for (struct cmsghdr *h = CMSG_FIRSTHDR(&message); h; h = CMSG_NXTHDR(&message, h)) {
    if (h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_CREDENTIALS || h->cmsg_len != CMSG_LEN(sizeof(writer))) return -1;
    memcpy(&writer, CMSG_DATA(h), sizeof(writer)); credentials++;
  }
  if (credentials != 1 || writer.pid <= 0) return -1;
  printf("{\"event\":\"received\",\"writer\":{\"pid\":%d,\"uid\":%u,\"gid\":%u},\"parentAlive\":%s,\"hex\":\"", writer.pid, writer.uid, writer.gid, parent_alive(birth) ? "true" : "false");
  for (ssize_t i = 0; i < length; i++) printf("%02x", (unsigned char)bytes[i]);
  puts("\"}"); fflush(stdout); return 0;
}
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "early")) return 7;
  /* Capture actual kernel parent before looking at any descriptor-supplied data. */
  pid_t parent = getppid(); if (parent <= 1) return 20;
  int birth = (int)syscall(SYS_pidfd_open, parent, 0);
  if (birth < 0 || fcntl(birth, F_SETFD, FD_CLOEXEC) != 0 || !parent_alive(birth)) return 21;
  struct ucred creator; socklen_t size = sizeof(creator); int passcred = 0; socklen_t int_size = sizeof(passcred);
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &creator, &size) || size != sizeof(creator)
      || getsockopt(3, SOL_SOCKET, SO_PASSCRED, &passcred, &int_size)) return 22;
  int flags = fcntl(3, F_GETFL), fdflags = fcntl(3, F_GETFD);
  if (flags < 0 || fdflags < 0) return 23;
  printf("{\"event\":\"start\",\"parent\":%d,\"creator\":%d,\"parentAlive\":%s,\"passcred\":%d,\"blocking\":%s,\"cloexec\":%s}\n", parent, creator.pid, parent_alive(birth) ? "true" : "false", passcred, (flags & O_NONBLOCK) ? "false" : "true", (fdflags & FD_CLOEXEC) ? "true" : "false");
  fflush(stdout);
  char *line = NULL; size_t capacity = 0;
  while (getline(&line, &capacity, stdin) >= 0) {
    size_t length = strlen(line); if (length > 4096) return 24;
    if (length && line[length - 1] == '\n') line[--length] = 0;
    if (!strncmp(line, "emit ", 5)) { if (output(line + 5, length - 5)) return 25; }
    else if (!strcmp(line, "recv")) { if (receive_parent(birth)) return 26; }
    else if (!strncmp(line, "foreign ", 8)) {
      pid_t pid = fork(); if (pid < 0) return 27;
      if (!pid) _exit(output(line + 8, length - 8) ? 28 : 0);
      int status; if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status)) return 29;
      printf("{\"event\":\"foreign\",\"pid\":%d}\n", pid); fflush(stdout);
    } else if (!strncmp(line, "rights ", 7)) {
      int count = atoi(line + 7); if (count < 1 || count > 253 || rights(count)) return 30;
    } else if (!strcmp(line, "eof")) close(3);
    else if (!strcmp(line, "exit")) break;
    else return 31;
    fputs("ack\n", stderr); fflush(stderr);
  }
  free(line); close(birth); return 0;
}
