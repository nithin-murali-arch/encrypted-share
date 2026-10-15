#!/bin/sh
set -eu
archive=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
work=$(mktemp -d)
network=es-example-$$
receiver=es-receiver-$$
cleanup() {
  docker rm -f "$receiver" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
cp "$archive" "$work/package.tgz"
mkdir "$work/source" "$work/received"
printf 'field device log\n' > "$work/source/device.log"
docker network create --internal "$network" >/dev/null
docker run -d --name "$receiver" --network "$network" -v "$work:/proof" node:22-alpine sh -c 'npm install --offline --global --cache /tmp/empty-cache /proof/package.tgz >/tmp/install.log && encrypted-share serve --host 0.0.0.0 --port 3000 --key container-proof-password --out /proof/received' >/dev/null
attempt=0
until docker logs "$receiver" 2>&1 | grep -q 'Server listening'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ]; then docker logs "$receiver"; exit 1; fi
  sleep 1
done
docker run --rm --network "$network" -v "$work:/proof" node:22-alpine sh -c "npm install --offline --global --cache /tmp/empty-cache /proof/package.tgz >/tmp/install.log && encrypted-share send /proof/source --target $receiver:3000 --key container-proof-password"
cmp "$work/source/device.log" "$work/received/device.log"
printf 'PASS two containers on an internal Docker network; explicit --host accepted; cmp identical\n'
