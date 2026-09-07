#!/usr/bin/env bash
#
# Brings up the containers the integration and end-to-end tests run against:
#   - SQL Server 2022 on localhost:11433
#   - an sshd on localhost:2222 that can reach it, for the tunnel tests
#
# Usage: scripts/test-env.sh up | down | status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYDIR="$ROOT/.tmp/sshkeys"
SA_PASSWORD='Beekeeper#2024!'
NETWORK=beekeeper-net

up() {
  echo "==> network"
  docker network create "$NETWORK" >/dev/null 2>&1 || true

  echo "==> SQL Server"
  if ! docker ps --format '{{.Names}}' | grep -qx beekeeper-mssql; then
    docker rm -f beekeeper-mssql >/dev/null 2>&1 || true
    docker run -d --name beekeeper-mssql \
      --network "$NETWORK" \
      -e ACCEPT_EULA=Y \
      -e "MSSQL_SA_PASSWORD=$SA_PASSWORD" \
      -e MSSQL_PID=Developer \
      -p 11433:1433 \
      --memory=2g \
      mcr.microsoft.com/mssql/server:2022-latest >/dev/null
  fi

  echo "==> SSH server"
  mkdir -p "$KEYDIR"
  [ -f "$KEYDIR/id_ed25519" ] || ssh-keygen -t ed25519 -N '' -C beekeeper-test -f "$KEYDIR/id_ed25519" >/dev/null
  [ -f "$KEYDIR/id_ed25519_pp" ] || ssh-keygen -t ed25519 -N 'secretpass' -C beekeeper-test-pp -f "$KEYDIR/id_ed25519_pp" >/dev/null

  if ! docker ps --format '{{.Names}}' | grep -qx beekeeper-ssh; then
    docker rm -f beekeeper-ssh >/dev/null 2>&1 || true
    docker run -d --name beekeeper-ssh \
      --network "$NETWORK" \
      -e PUID=1000 -e PGID=1000 -e TZ=UTC \
      -e USER_NAME=tunneluser \
      -e USER_PASSWORD=tunnelpass \
      -e PASSWORD_ACCESS=true \
      -e SUDO_ACCESS=false \
      -p 2222:2222 \
      lscr.io/linuxserver/openssh-server:latest >/dev/null
  fi

  echo "==> waiting for SQL Server"
  for i in $(seq 1 120); do
    if docker exec beekeeper-mssql /opt/mssql-tools18/bin/sqlcmd \
        -S localhost -U sa -P "$SA_PASSWORD" -C -Q 'SELECT 1' >/dev/null 2>&1; then
      echo "    ready after ${i}s"
      break
    fi
    sleep 1
  done

  echo "==> configuring sshd (the image ships with AllowTcpForwarding no)"
  for i in $(seq 1 60); do
    if docker exec beekeeper-ssh test -f /config/sshd/sshd_config 2>/dev/null; then break; fi
    sleep 1
  done
  docker exec beekeeper-ssh sh -c \
    "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config /config/sshd/sshd_config" || true
  docker exec beekeeper-ssh sh -c \
    "printf '%s\n%s\n' '$(cat "$KEYDIR/id_ed25519.pub")' '$(cat "$KEYDIR/id_ed25519_pp.pub")' \
     > /config/.ssh/authorized_keys && chmod 600 /config/.ssh/authorized_keys"
  docker restart beekeeper-ssh >/dev/null

  echo "==> waiting for sshd"
  for i in $(seq 1 60); do
    if ssh -i "$KEYDIR/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -o BatchMode=yes -p 2222 tunneluser@127.0.0.1 true 2>/dev/null; then
      echo "    ready after ${i}s"
      break
    fi
    sleep 1
  done

  status
}

down() {
  docker rm -f beekeeper-mssql beekeeper-ssh >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  echo "test environment removed"
}

status() {
  echo
  docker ps --filter name=beekeeper- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo
  echo "SQL Server  127.0.0.1:11433   sa / $SA_PASSWORD"
  echo "SSH         127.0.0.1:2222    tunneluser / tunnelpass   keys in $KEYDIR"
  echo "From inside the SSH container the database is beekeeper-mssql:1433"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 1 ;;
esac
