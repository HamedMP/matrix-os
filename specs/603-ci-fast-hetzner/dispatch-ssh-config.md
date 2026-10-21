# Dispatcher SSH configuration

The first real Ubuntu dispatcher installation failed its `sshd -t` check:
`PermitUserEnvironment` is a global directive and cannot appear inside a
`Match User` block. Installation correctly stopped before reloading SSH.

Move `PermitUserEnvironment no` before the dedicated-user Match block. Keep
the forced command, restricted public key, forwarding/PTY prohibitions,
key-only login, and validated-before-reload ordering. The setting remains
disabled globally; no environment injection is enabled.

Validation: the installer placement contract must fail before the change,
all runner/dispatcher contracts must pass afterward, and the actual Ubuntu
configuration must pass `sshd -t`. Test the dedicated key against shell,
argument injection, SCP, and PTY requests; automatic GitHub dispatch stays
disabled pending the reviewed stack and verified host key.

Public documentation remains the separate `FinnaAI/matrix-os-site` testing
guide PR, which documents forced-key admission and its activation requirements.
