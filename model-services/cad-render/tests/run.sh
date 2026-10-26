#!/bin/sh
# Run the renderer tests inside a running cad-render container.
# usage: tests/run.sh [container] [path-to-wall-mount.stp]
set -e
container="${1:-cadam-models-cad-render-1}"
here="$(cd "$(dirname "$0")/.." && pwd)"
docker exec "$container" rm -rf /tmp/cadtests 2>/dev/null || true
docker exec "$container" mkdir -p /tmp/cadtests/tests
docker cp "$here/worker.py" "$container:/tmp/cadtests/worker.py"
docker cp "$here/features.py" "$container:/tmp/cadtests/features.py"
for test in "$here"/tests/test_*.py; do
  docker cp "$test" "$container:/tmp/cadtests/tests/$(basename "$test")"
done
env=""
if [ -n "$2" ]; then
  docker cp "$2" "$container:/tmp/cadtests/part.stp"
  env="-e CADAM_TEST_STEP=/tmp/cadtests/part.stp"
fi
docker exec $env "$container" python -m unittest discover -s /tmp/cadtests/tests -v
