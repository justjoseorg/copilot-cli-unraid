#!/bin/sh
set -eu

runtime=${CONTAINER_RUNTIME:-docker}
image=${1:-copilot-cli:test}
container="copilot-cli-smoke-$$"
config="${container}-config"
workspace="${container}-workspace"
credentials='terminal:test-only:password'

cleanup() {
    "$runtime" rm -f "$container" >/dev/null 2>&1 || true
    "$runtime" volume rm "$config" "$workspace" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if output=$("$runtime" run --rm "$image" 2>&1); then
    echo "The terminal started without a password." >&2
    exit 1
fi
case "$output" in
    *"WEB_TERMINAL_PASSWORD must be set"*) ;;
    *) printf '%s\n' "$output" >&2; exit 1 ;;
esac

if output=$("$runtime" run --rm \
    -e WEB_TERMINAL_USER=invalid:user \
    -e WEB_TERMINAL_PASSWORD=test-only "$image" 2>&1); then
    echo "The terminal accepted a colon in the username." >&2
    exit 1
fi
case "$output" in
    *"WEB_TERMINAL_USER cannot contain a colon"*) ;;
    *) printf '%s\n' "$output" >&2; exit 1 ;;
esac

"$runtime" volume create "$config" >/dev/null
"$runtime" volume create "$workspace" >/dev/null

start() {
    "$runtime" run -d --name "$container" \
        -e WEB_TERMINAL_PASSWORD=test-only:password \
        -v "$config:/config" -v "$workspace:/workspace" \
        "$image" >/dev/null

    attempt=0
    until [ "$attempt" -ge 60 ]; do
        code=$("$runtime" exec "$container" curl -s -o /dev/null \
            -w '%{http_code}' http://127.0.0.1:7681/ 2>/dev/null || true)
        if [ "$code" = 401 ]; then
            return
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    "$runtime" logs "$container" >&2
    echo "Web terminal did not become ready." >&2
    exit 1
}

start
code=$("$runtime" exec "$container" curl -sS -u "$credentials" \
    -o /dev/null -w '%{http_code}' http://127.0.0.1:7681/)
test "$code" = 200
"$runtime" exec "$container" sh -ec '
    test "$HOME" = /config
    test "$PWD" = /workspace
    copilot --version
    gh --version
    touch /config/.copilot/container-smoke-state /workspace/container-smoke-state
    apk add --no-cache jq
    test "$(cat /config/apk-packages)" = jq
'

"$runtime" rm -f "$container" >/dev/null
start
"$runtime" exec "$container" sh -ec '
    test -f /config/.copilot/container-smoke-state
    test -f /workspace/container-smoke-state
    jq --version
    apk del jq
    test ! -s /config/apk-packages
'

"$runtime" rm -f "$container" >/dev/null
start
"$runtime" exec "$container" sh -ec '
    test -f /workspace/container-smoke-state
    ! /sbin/apk info -e jq
'
echo "CLI startup, HTTP authentication and cross-container persistence passed."
