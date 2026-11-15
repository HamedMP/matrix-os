/* Test-only syscall-return faults AFTER actual recvmsg. Never linked in production. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
ssize_t __real_recvmsg(int socket, struct msghdr *message, int flags);
ssize_t __wrap_recvmsg(int socket, struct msghdr *message, int flags) {
  ssize_t length = __real_recvmsg(socket, message, flags);
  const char *fault = getenv("MATRIX_STDOUT_TEST_FAULT");
  if (length <= 0 || !fault) return length;
  if (strcmp(fault, "missing") == 0) message->msg_controllen = 0;
  else if (strcmp(fault, "truncated") == 0) message->msg_flags |= MSG_CTRUNC;
  else if (strcmp(fault, "unexpected") == 0) { struct cmsghdr *header = CMSG_FIRSTHDR(message); if (header) header->cmsg_type = 0x7fff; }
  else if (strcmp(fault, "baduid") == 0 || strcmp(fault, "badgid") == 0 || strcmp(fault, "badpid") == 0) {
    struct cmsghdr *header = CMSG_FIRSTHDR(message);
    if (header && header->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred *writer = (struct ucred *)CMSG_DATA(header);
      if (strcmp(fault, "baduid") == 0) writer->uid++;
      if (strcmp(fault, "badgid") == 0) writer->gid++;
      if (strcmp(fault, "badpid") == 0) writer->pid++;
    }
  } else if (strcmp(fault, "duplicate") == 0) {
    struct cmsghdr *header = CMSG_FIRSTHDR(message);
    if (header && message->msg_controllen >= CMSG_SPACE(sizeof(struct ucred))) {
      /* Production provides space for bounded rights as well as credentials. */
      memcpy((char *)message->msg_control + CMSG_SPACE(sizeof(struct ucred)), header, CMSG_SPACE(sizeof(struct ucred)));
      message->msg_controllen = 2 * CMSG_SPACE(sizeof(struct ucred));
    }
  } else if (strcmp(fault, "readerror") == 0) { errno = EIO; return -1; }
  return length;
}
