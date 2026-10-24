#!/usr/bin/env bash
# Job containers on the matrix-ci-pool network may reach only public IPv4 hosts: no host services,
# private networks, link-local metadata or multicast. Installed as matrix-ci-pool-firewall.service.
set -euo pipefail
bridge=matrix-ci-pool0
chain=MATRIX-CI-POOL-EGRESS
iptables -N "$chain" 2>/dev/null || true
iptables -F "$chain"
iptables -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 \
  192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A "$chain" -d "$cidr" -j REJECT
done
iptables -A "$chain" -j RETURN
iptables -C DOCKER-USER -i "$bridge" -j "$chain" 2>/dev/null || iptables -I DOCKER-USER 1 -i "$bridge" -j "$chain"
# Container-to-host traffic is INPUT, not DOCKER-USER; reject it, including the host's public IP.
iptables -C INPUT -i "$bridge" -j REJECT 2>/dev/null || iptables -I INPUT 1 -i "$bridge" -j REJECT
