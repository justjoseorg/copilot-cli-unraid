#!/bin/sh
set -eu

runtime=${CONTAINER_RUNTIME:-docker}
image=${1:-copilot-cli:test}
container="copilot-cli-smoke-$$"
config="${container}-config"
workspace="${container}-workspace"
credentials='smoke-user:test-only:password'

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
        -e WEB_TERMINAL_USER=smoke-user \
        -e WEB_TERMINAL_PASSWORD=test-only:password \
        -v "$config:/config" -v "$workspace:/Storage/repos" \
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
    test "$PWD" = /Storage/repos
    copilot --version
    gh --version
    touch /config/.copilot/container-smoke-state /Storage/repos/container-smoke-state
    test "$(stat -c %a /config/.keyring-password)" = 600
    printf dummy-keyring-smoke-secret | secret-tool store \
        --label="Copilot image smoke test" service copilot-cli-unraid-smoke account test
    apk add --no-cache jq
    test "$(cat /config/apk-packages)" = jq
'

"$runtime" rm -f "$container" >/dev/null
start
"$runtime" exec "$container" sh -ec '
    test -f /config/.copilot/container-smoke-state
    test -f /Storage/repos/container-smoke-state
    test "$(secret-tool lookup service copilot-cli-unraid-smoke account test)" = dummy-keyring-smoke-secret
    jq --version
    apk del jq
    test ! -s /config/apk-packages
'

"$runtime" rm -f "$container" >/dev/null
start
"$runtime" exec "$container" sh -ec '
    test -f /Storage/repos/container-smoke-state
    ! /sbin/apk info -e jq
    test "$(secret-tool lookup service copilot-cli-unraid-smoke account test)" = dummy-keyring-smoke-secret
    mv /config/.keyring-password /config/.keyring-password.saved
    printf wrong-test-password > /config/.keyring-password
'
"$runtime" rm -f "$container" >/dev/null
if output=$("$runtime" run --rm -v "$config:/config" "$image" true 2>&1); then
    echo "Startup accepted the wrong keyring unlock secret." >&2
    exit 1
fi
case "$output" in
    *"Cannot unlock the persistent keyring"*) ;;
    *) printf '%s\n' "$output" >&2; exit 1 ;;
esac
"$runtime" run --rm --entrypoint sh -v "$config:/config" "$image" -ec '
    mv /config/.keyring-password.saved /config/.keyring-password
'
start
"$runtime" exec "$container" sh -ec '
    test "$(secret-tool lookup service copilot-cli-unraid-smoke account test)" = dummy-keyring-smoke-secret
    rm /config/.keyring-password
'
"$runtime" rm -f "$container" >/dev/null
if output=$("$runtime" run --rm -v "$config:/config" "$image" true 2>&1); then
    echo "Startup replaced a missing keyring unlock secret." >&2
    exit 1
fi
case "$output" in
    *"Keyring data exists but its unlock secret is missing"*) ;;
    *) printf '%s\n' "$output" >&2; exit 1 ;;
esac
echo "CLI startup, HTTP authentication and configuration/workspace/keyring/package persistence passed."
