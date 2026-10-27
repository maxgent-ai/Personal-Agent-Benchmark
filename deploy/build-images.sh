#!/bin/sh
# Builds the two images one task is replayed from, on this machine; nothing is pushed:
#   pab-replay:<digest>        the replay service, from this checkout (deploy/Dockerfile)
#   pab-task:<id>-<digest>     the task directory (deploy/task/Dockerfile)
# Each tag is a digest of what goes into the image, so an image is built again only when its
# content changed. Prints the two image names, replay first.
#   sh deploy/build-images.sh tasks/<id>
set -e
cd "$(dirname "$0")/.."
TASK=${1:?usage: sh deploy/build-images.sh tasks/<id>}
[ -f "$TASK/task.yaml" ] || { echo "$TASK has no task.yaml" >&2; exit 1; }

# digest of file names and contents under the given paths (relative to the current directory)
digest() {
  find "$@" -type f ! -name .DS_Store | LC_ALL=C sort | while read -r f; do
    echo "$f"
    shasum -a 256 < "$f"
  done | shasum -a 256 | cut -c1-12
}

build() { # image, dockerfile, context
  if docker image inspect "$1" >/dev/null 2>&1; then return; fi
  docker build -q -f "$2" -t "$1" "$3" >&2
}

REPLAY=pab-replay:$(digest package.json package-lock.json tsconfig.json bin src plugins sites scripts deploy/Dockerfile)
build "$REPLAY" deploy/Dockerfile .

ID=$(basename "$(cd "$TASK" && pwd)")
TASK_DIGEST=$({ (cd "$TASK" && digest .); shasum -a 256 < deploy/task/Dockerfile; } | shasum -a 256 | cut -c1-12)
TASK_IMAGE=pab-task:$ID-$TASK_DIGEST
build "$TASK_IMAGE" deploy/task/Dockerfile "$TASK"

echo "$REPLAY"
echo "$TASK_IMAGE"
