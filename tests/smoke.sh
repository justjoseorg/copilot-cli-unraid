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
"$runtime" exec "$container" node --input-type=module -e '
    import assert from "node:assert/strict";
    const origin = "http://127.0.0.1:7681";
    const headers = {
        Authorization: "Basic " + Buffer.from(process.env.WEB_TERMINAL_USER + ":" + process.env.WEB_TERMINAL_PASSWORD).toString("base64"),
        Origin: origin,
    };
    const created = await fetch(origin + "/api/terminals", { method: "POST", headers });
    assert.equal(created.status, 200);
    const terminal = await created.json();
    const listed = await fetch(origin + "/api/terminals", { headers });
    assert((await listed.json()).terminals.some(item => item.id === terminal.id));
    const closed = await fetch(origin + "/api/terminals/" + terminal.id, { method: "DELETE", headers });
    assert.equal(closed.status, 200);
'
"$runtime" exec "$container" sh -ec '
    curl -fsS -u "smoke-user:test-only:password" http://127.0.0.1:7681/ | grep -q "id=\"new-terminal\""
    curl -fsS -u "smoke-user:test-only:password" http://127.0.0.1:7681/terminal/ >/dev/null
    test "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7681/terminal/token)" = 401
'
"$runtime" exec "$container" sh -ec '
    test "$HOME" = /config
    test "$PWD" = /Storage/repos
    copilot --version
    gh --version
    touch /config/.copilot/container-smoke-state /Storage/repos/container-smoke-state
    test "$(stat -c %a /config/.keyring-password)" = 600
    printf dummy-keyring-smoke-secret | secret-tool store \
        --label="Copilot image smoke test" service copilot-cli-unraid-smoke account test
    test "$(command -v python)" = /config/python/bin/python
    pip install --disable-pip-version-check six==1.17.0
    npm install --global --ignore-scripts semver@7.7.2
    apk add --no-cache jq
    test "$(cat /config/apk-packages)" = jq
'

"$runtime" rm -f "$container" >/dev/null
start
"$runtime" exec "$container" sh -ec '
    test -f /config/.copilot/container-smoke-state
    test -f /Storage/repos/container-smoke-state
    test "$(secret-tool lookup service copilot-cli-unraid-smoke account test)" = dummy-keyring-smoke-secret
    python -c "import six; assert six.__version__ == \"1.17.0\""
    test "$(command -v semver)" = /config/npm/bin/semver
    test "$(semver 1.2.3)" = 1.2.3
    jq --version
    apk del jq
    test ! -s /config/apk-packages
'
"$runtime" exec "$container" sh -lc '
    test "$(command -v python)" = /config/python/bin/python
    test "$(command -v pip)" = /config/python/bin/pip
    test "$(command -v semver)" = /config/npm/bin/semver
'

"$runtime" rm -f "$container" >/dev/null
start
"$runtime" exec "$container" sh -ec '
    test -f /Storage/repos/container-smoke-state
    ! /sbin/apk info -e jq
    test "$(secret-tool lookup service copilot-cli-unraid-smoke account test)" = dummy-keyring-smoke-secret
    python -c "import six; assert six.__version__ == \"1.17.0\""
    test "$(semver 1.2.3)" = 1.2.3
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
