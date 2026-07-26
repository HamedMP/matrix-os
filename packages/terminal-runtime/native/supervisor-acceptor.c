#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define PUBLIC_SOCKET "/run/matrix-terminal-runtime/supervisor.sock"
#define KEEPER_SOCKET "/run/matrix-terminal-runtime/keeper.sock"
#define WORKER "/opt/matrix/bin/matrix-terminal-runtime-op"
#define MAX_WORKERS 128

static volatile sig_atomic_t stopping = 0;

static void handle_signal(int signal_number) {
  (void)signal_number;
  stopping = 1;
}

static int set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int create_listener(const char *path, uid_t owner_uid, gid_t owner_gid) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;

  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) {
    close(fd);
    errno = ENAMETOOLONG;
    return -1;
  }
  memcpy(address.sun_path, path, strlen(path) + 1);
  if (unlink(path) < 0 && errno != ENOENT) {
    close(fd);
    return -1;
  }
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
    close(fd);
    return -1;
  }
  if (chown(path, owner_uid, owner_gid) < 0 || chmod(path, 0600) < 0) {
    close(fd);
    unlink(path);
    return -1;
  }
  if (listen(fd, 64) < 0) {
    close(fd);
    unlink(path);
    return -1;
  }
  return fd;
}

static int write_all(int fd, const void *buffer, size_t length) {
  const uint8_t *cursor = buffer;
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(fd, cursor + written, length - written);
    if (result < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    written += (size_t)result;
  }
  return 0;
}

static pid_t serve_connection(int connection, const char *mode,
                              uid_t matrix_uid) {
  struct ucred credentials;
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(connection, SOL_SOCKET, SO_PEERCRED, &credentials,
                 &credentials_length) < 0 ||
      credentials_length != sizeof(credentials) ||
      credentials.uid != matrix_uid || credentials.pid < 1) {
    close(connection);
    return -1;
  }

  int credential_pipe[2];
  if (pipe(credential_pipe) < 0) {
    close(connection);
    return -1;
  }
  if (set_cloexec(credential_pipe[0]) < 0 ||
      set_cloexec(credential_pipe[1]) < 0) {
    close(credential_pipe[0]);
    close(credential_pipe[1]);
    close(connection);
    return -1;
  }

  pid_t child = fork();
  if (child < 0) {
    close(credential_pipe[0]);
    close(credential_pipe[1]);
    close(connection);
    return -1;
  }
  if (child == 0) {
    close(credential_pipe[1]);
    if (dup2(connection, STDIN_FILENO) < 0 ||
        dup2(connection, STDOUT_FILENO) < 0) {
      _exit(126);
    }
    close(connection);
    if (credential_pipe[0] != 3) {
      if (dup2(credential_pipe[0], 3) < 0) _exit(126);
      close(credential_pipe[0]);
    } else {
      int flags = fcntl(3, F_GETFD);
      if (flags < 0 || fcntl(3, F_SETFD, flags & ~FD_CLOEXEC) < 0) {
        _exit(126);
      }
    }
    char *const arguments[] = {(char *)WORKER, (char *)mode, NULL};
    execv(WORKER, arguments);
    _exit(127);
  }

  close(credential_pipe[0]);
  close(connection);
  uint32_t serialized[3] = {
      (uint32_t)credentials.pid,
      (uint32_t)credentials.uid,
      (uint32_t)credentials.gid,
  };
  (void)write_all(credential_pipe[1], serialized, sizeof(serialized));
  close(credential_pipe[1]);
  return child;
}

static pid_t spawn_maintenance(void) {
  pid_t child = fork();
  if (child != 0) return child;
  char *const arguments[] = {
      (char *)WORKER, (char *)"maintenance", NULL};
  execv(WORKER, arguments);
  _exit(127);
}

static void reap_children(pid_t *maintenance, size_t *workers) {
  pid_t child;
  while ((child = waitpid(-1, NULL, WNOHANG)) > 0) {
    if (child == *maintenance) {
      *maintenance = -1;
    } else if (*workers > 0) {
      *workers -= 1;
    }
  }
}

int main(void) {
  struct passwd *matrix = getpwnam("matrix");
  if (matrix == NULL || matrix->pw_uid == 0) {
    fputs("terminal_runtime_owner_unavailable\n", stderr);
    return 1;
  }

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = handle_signal;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) < 0 ||
      sigaction(SIGINT, &action, NULL) < 0) {
    return 1;
  }

  int public_listener = create_listener(
      PUBLIC_SOCKET, matrix->pw_uid, matrix->pw_gid);
  int keeper_listener = create_listener(
      KEEPER_SOCKET, matrix->pw_uid, matrix->pw_gid);
  if (public_listener < 0 || keeper_listener < 0) {
    if (public_listener >= 0) close(public_listener);
    if (keeper_listener >= 0) close(keeper_listener);
    unlink(PUBLIC_SOCKET);
    unlink(KEEPER_SOCKET);
    return 1;
  }

  struct pollfd listeners[2] = {
      {.fd = public_listener, .events = POLLIN, .revents = 0},
      {.fd = keeper_listener, .events = POLLIN, .revents = 0},
  };
  pid_t maintenance = spawn_maintenance();
  size_t workers = 0;
  if (maintenance < 0) stopping = 1;
  while (!stopping) {
    int result = poll(listeners, 2, 1000);
    if (result < 0) {
      if (errno == EINTR) continue;
      break;
    }
    reap_children(&maintenance, &workers);
    if (maintenance < 0 && !stopping) {
      maintenance = spawn_maintenance();
      if (maintenance < 0) {
        stopping = 1;
        break;
      }
    }
    for (size_t index = 0; index < 2; index += 1) {
      if ((listeners[index].revents & POLLIN) == 0) continue;
      int connection = accept4(
          listeners[index].fd, NULL, NULL, SOCK_CLOEXEC);
      if (connection < 0) {
        if (errno == EINTR) continue;
        stopping = 1;
        break;
      }
      if (workers >= MAX_WORKERS) {
        close(connection);
        continue;
      }
      pid_t worker = serve_connection(
          connection,
          index == 0 ? "serve-peer" : "serve-keeper",
          matrix->pw_uid);
      if (worker > 0) workers += 1;
    }
  }

  close(public_listener);
  close(keeper_listener);
  unlink(PUBLIC_SOCKET);
  unlink(KEEPER_SOCKET);
  if (maintenance > 0) (void)kill(maintenance, SIGTERM);
  while (waitpid(-1, NULL, 0) > 0 || errno == EINTR) {
  }
  return 0;
}
