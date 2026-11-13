/* A fresh native fixture. JSON bodies never manufacture kernel identity. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
static int output(const char *bytes, size_t length) {
  while (length) { ssize_t n = write(1, bytes, length); if (n < 0) { if (errno == EINTR) continue; return -1; } bytes += n; length -= (size_t)n; }
  return 0;
}
static int rights(int count) {
  int fds[253]; for (int i = 0; i < count; i++) fds[i] = 0;
  union { struct cmsghdr align; char bytes[CMSG_SPACE(253 * sizeof(int))]; } control;
  struct iovec vector = {(void *)"{}\n", 3}; struct msghdr message = {0};
  message.msg_iov = &vector; message.msg_iovlen = 1; message.msg_control = control.bytes; message.msg_controllen = CMSG_SPACE((size_t)count * sizeof(int));
  struct cmsghdr *header = CMSG_FIRSTHDR(&message); header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN((size_t)count * sizeof(int)); memcpy(CMSG_DATA(header), fds, (size_t)count * sizeof(int));
  return sendmsg(1, &message, MSG_NOSIGNAL) < 0 ? -1 : 0;
}
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "early") == 0) return 7;
  char *line = NULL; size_t size = 0;
  while (getline(&line, &size, stdin) >= 0) {
    size_t length = strlen(line); if (length && line[length - 1] == '\n') line[--length] = 0;
    if (strncmp(line, "emit ", 5) == 0) { if (output(line + 5, length - 5) || output("\n", 1)) break; }
    else if (strncmp(line, "partial ", 8) == 0) { if (output(line + 8, length - 8)) break; }
    else if (strncmp(line, "foreign ", 8) == 0) {
      pid_t pid = fork(); if (pid < 0) return 9;
      if (pid == 0) { output(line + 8, length - 8); output("\n", 1); _exit(0); }
      int status; if (waitpid(pid, &status, 0) != pid) return 10;
    } else if (strncmp(line, "rights ", 7) == 0) { if (rights(atoi(line + 7))) break; }
    else if (strcmp(line, "helper") == 0) {
      pid_t pid = fork(); if (pid < 0) return 13;
      if (pid == 0) _exit(0);
      int status; if (waitpid(pid, &status, 0) != pid) return 14;
    } else if (strcmp(line, "utf8") == 0) {
      const char bytes[] = "{\"bad\":\"\xff\"}\n"; output(bytes, sizeof(bytes) - 1);
    } else if (strcmp(line, "epipe") == 0) {
      signal(SIGPIPE, SIG_IGN);
      int failed = output("{}\n", 3);
      fputs(failed < 0 && errno == EPIPE ? "epipe\n" : "unexpected-write-result\n", stderr); fflush(stderr); break;
    } else if (strcmp(line, "flags") == 0) {
      char reply[128]; int n = snprintf(reply, sizeof(reply), "{\"blocking\":%s,\"cloexec\":%s}\n", (fcntl(1, F_GETFL) & O_NONBLOCK) ? "false" : "true", (fcntl(1, F_GETFD) & FD_CLOEXEC) ? "true" : "false");
      output(reply, (size_t)n);
    } else if (strcmp(line, "context") == 0) {
      char cwd[4096]; if (!getcwd(cwd, sizeof(cwd))) return 11;
      char reply[8192]; int n = snprintf(reply, sizeof(reply), "{\"cwd\":\"%s\",\"marker\":\"%s\",\"arg\":\"%s\"}\n", cwd, getenv("NATIVE_STDOUT_MARKER") ?: "", argc > 1 ? argv[1] : ""); output(reply, (size_t)n);
    } else if (strcmp(line, "stderr") == 0) { fputs("native stderr fixture\n", stderr); fflush(stderr); }
    else if (strcmp(line, "oversize") == 0) { char block[8192]; memset(block, 'x', sizeof(block)); for (int i = 0; i <= 2048; i++) if (output(block, sizeof(block))) break; }
    else if (strcmp(line, "eof") == 0) { close(1); }
    else if (strcmp(line, "exit") == 0) break;
    else return 12;
    /* A separate channel is the test's write-completed acknowledgement. */
    fputs("ack\n", stderr); fflush(stderr);
  }
  free(line); return 0;
}
