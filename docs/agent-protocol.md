# auto-wp agent protocol (v1)

The PHP agent (`agent-php/dist/agent.php`) exposes the actions in `packages/contracts/src/actions.ts`.
It runs in two modes that share one action implementation:

| Mode           | Invocation                                                                                       | Auth                                                 |
| -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| CLI (over SSH) | `php ~/.auto-wp/agent.php --cli <action>`; params JSON on **stdin**; response JSON on **stdout** | SSH itself; CLI mode refuses to run under a web SAPI |
| Web (no SSH)   | `POST <endpoint>` with JSON body                                                                 | Signed headers below; HTTPS required                 |

Core actions (`fs.*`, `db.*`, `wp.maintenance`, `logs.tail`, `cache.flush`, `lock.*`, `job.status`, `probe`) **must not load WordPress**: they read DB credentials by parsing `wp-config.php` with a tokenizer (never `include`), so they keep working when WordPress is fatally broken. Bridge actions (`wp.inventory`, `wp.upgrade`) bootstrap WordPress in an isolated sub-process/sub-request guarded by `register_shutdown_function`, returning error code `wp_fatal` when WordPress dies. As a long-running action, `wp.upgrade` may return a job handle.

## Request

```
POST /auto-wp-agent/agent.php
Content-Type: application/json
X-AutoWP-Site: <siteId>
X-AutoWP-Key-Id: <keyId>
X-AutoWP-Alg: ed25519 | hmac-sha256
X-AutoWP-Timestamp: <unix seconds>
X-AutoWP-Nonce: <16 random bytes, base64url, no padding — exactly 22 chars [A-Za-z0-9_-]>
X-AutoWP-Signature: <base64 signature over the canonical string>

{"action":"db.dump","params":{...}}
```

Canonical string (UTF-8, `\n` separated, no trailing newline):

```
AUTOWP-SIG-V1
<METHOD upper-case>
<URL path, no query>
<timestamp>
<nonce>
<siteId>
<lowercase hex sha256 of the raw body bytes>
```

- **ed25519** (default): the agent stores only the controller's **public** key. Uses ext-sodium or bundled `paragonie/sodium_compat`.
- **hmac-sha256** (optional): shared secret; compare with `hash_equals`.

## Verification order (agent)

1. Optional IP allowlist check, then the optional `expires_at` kill switch.
2. Method must be POST, body ≤ configured max (default 16 MiB).
3. All headers present; nonce matches `^[A-Za-z0-9_-]{22}$`; key id known; site id matches config.
4. `|now - timestamp| ≤ 300`.
5. Signature valid.
6. Nonce not seen within 600 s (stored in a `flock`ed file inside the agent's private data dir); then record it.
7. Action in allowlist; params validated.

**Any failure in steps 1–6 → an empty HTTP 404** (no body and no reason given; it is not guaranteed to look identical to the web server's own 404 page). Failures are logged to the agent's audit log without secrets.

## Response

```json
{"ok": true, "result": { ... }}
{"ok": true, "job": {"jobId": "..."}}
{"ok": false, "error": {"code": "invalid_params", "message": "..."}}
```

Long-running actions (`LONG_RUNNING_ACTIONS`, including `wp.upgrade`) may return a job. The client polls `job.status` (also signed) until `state` is `done` (the `result` holds the action result) or `failed`. Jobs are resumable across requests: each poll advances the job by one time-boxed slice (≈ 20 s) so it stays under shared-host `max_execution_time`.

Error codes: see `AGENT_ERROR_CODES` in `packages/contracts/src/protocol.ts`.

## Paths

POSIX. Relative paths resolve against the WP root. After `realpath` (or a lexical normalisation for paths that don't exist yet), every path must be inside the WP root or the configured outside-docroot dir, otherwise the error is `path_jail`. The agent's own directory and config are always off-limits to `fs.*`.

## Test vectors

`packages/contracts/test-vectors.json` contains a fixed Ed25519 seed/public key, an HMAC key, sample requests with their canonical strings and signatures, and rejection cases evaluated at `serverTime`. Both the TS client (`packages/transport-agent`) and the PHP agent must pass every case.
