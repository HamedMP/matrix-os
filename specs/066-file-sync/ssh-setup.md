# Container-Side SSH Setup

How SSH access works inside Matrix OS cloud containers.

## OpenSSH Configuration

Container runs `sshd` on port 2222 (non-privileged). Configuration at `/etc/ssh/sshd_config`:

```
Port 2222
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile /home/matrixos/.ssh/authorized_keys
ClientAliveInterval 60
ClientAliveCountMax 3
```

## Authorized Keys Sync

Keys are managed through the sync system:

1. User runs `matrixos keys add ~/.ssh/id_ed25519.pub`
2. Key is written to `~/system/authorized_keys` in the user's sync folder
3. Sync daemon uploads to R2 via the standard sync flow
4. Container daemon receives `sync:change` event for `system/authorized_keys`
5. Container copies the file to `~/.ssh/authorized_keys` with `0600` permissions

The container watches for changes to `system/authorized_keys` and updates `~/.ssh/authorized_keys` automatically.

## tmux Session Sharing

Default shell profile (`~/.profile`) auto-attaches to a shared tmux session:

```bash
if [ -n "$SSH_CONNECTION" ] && command -v tmux &>/dev/null; then
  if tmux has-session -t main 2>/dev/null; then
    exec tmux attach -t main
  else
    exec tmux new-session -s main
  fi
fi
```

This means:
- Web terminal creates `tmux` session `main` on first connection
- SSH connections attach to the same session
- Multiple SSH clients see the same terminal
- Disconnect and reconnect -- tmux keeps the session alive

## Platform Proxy Routing

The platform proxy at `ssh.matrix-os.com:2222` routes connections to the correct container:

1. Client connects to `ssh.matrix-os.com:2222`
2. Proxy inspects the SSH handshake for the public key
3. Looks up which container the key belongs to via the platform API
4. Forwards the TCP connection to the container's internal port 2222

For shared instances (`matrixos ssh @colleague:matrix-os.com`):
1. CLI resolves the handle via `GET /api/ssh/resolve?handle=colleague`
2. Gateway checks the `sync_shares` table for SSH permission
3. Returns the container host:port if the user has `editor` or `admin` role
4. CLI connects directly to the resolved address

## Dockerfile Addition

```dockerfile
RUN apt-get update && apt-get install -y openssh-server tmux \
    && mkdir /var/run/sshd \
    && sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication .*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# Run sshd alongside the main process
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
```

Supervisord config manages both the Matrix OS gateway and sshd.

## Security Considerations

- Port 2222 avoids requiring root for binding
- Password auth is disabled -- keys only
- `StrictHostKeyChecking=accept-new` on client side for first connection TOFU
- Container runs as non-root `matrixos` user
- SSH access requires an active share with `editor` or `admin` role for shared instances
- Platform proxy validates the connection before forwarding
