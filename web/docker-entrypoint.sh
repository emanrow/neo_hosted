#!/bin/sh
# Starts NEO as the unprivileged `node` user on a volume that was mounted by
# root. Railway (and Docker) hand the container /data owned by root, so a
# plain `USER node` image fails its first sign-up with EACCES on users.json.
# The image therefore starts as root, gives the volume's top folder to `node`
# (files `node` creates inside are its own already, so no recursive chown and
# no slow boot on a big library), and execs the server as `node` so PID 1
# still receives Railway's stop signal.
set -e
DATA_DIR="${NEO_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups node web/server.js
fi
exec node web/server.js
