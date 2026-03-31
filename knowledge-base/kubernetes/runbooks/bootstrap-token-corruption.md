# Bootstrap Token Corruption — SSM SecureString Backslash Injection

> **Severity:** Critical — prevents all `kubeadm join` operations  
> **Affected components:** Worker node bootstrap (both legacy and modular)  
> **Root cause:** Shell-encoding artifact in SSM SecureString retrieval  
> **Status:** Fixed — deployed validation across all bootstrap paths

## Incident Summary

Worker nodes failed to join the Kubernetes cluster because the
`kubeadm join` command received a corrupted bootstrap token. The
SSM Parameter Store value `/k8s/development/join-token` contained
a leading backslash character (e.g. `\ku8rm0.abc1234567890123`)
that was injected during shell retrieval of the SSM SecureString.

### SSM Automation Execution Failures

| Execution ID | Document | Status | Date |
| --- | --- | --- | --- |
| `9ea1d279-9ebf-4daa-8f2a-08eb347ffed3` | `k8s-dev-bootstrap-worker` | Failed | 30 Mar 2026 |
| `7325f1e6-3fe5-4251-bdd3-458649a41fe2` | `k8s-dev-bootstrap-worker` | Failed | 30 Mar 2026 |

### Error Signature

```
[kubelet-check] Failed to connect to API server at \ku8rm0.xyz...
error: invalid format for token
```

## Root Cause Analysis

1. **SSM `ssm_get()` uses `--output text`** — AWS CLI formats
   SecureString values as text, which can inject escape characters
   depending on the shell context.
2. **No validation was performed** on the raw token value between
   SSM retrieval and passing it to `kubeadm join`.
3. The token rotator script also lacked format validation, meaning
   a corrupted token could be written back to SSM, propagating the
   corruption cycle.

### Corruption Pattern

```
Expected: ku8rm0.abc1234567890123    (format: [a-z0-9]{6}.[a-z0-9]{16})
Actual:   \ku8rm0.abc1234567890123   (leading backslash from shell escaping)
```

## Fix Applied

### 1. Central Validation Utility (`common.py`)

New `validate_kubeadm_token(token, source)` function:
- Strips whitespace and leading backslash characters
- Validates against strict regex: `^[a-z0-9]{6}\.[a-z0-9]{16}$`
- Raises `ValueError` with descriptive message + source label on failure
- Truncates raw value in error message (never logs full token)

### 2. Files Modified

| File | Change |
| --- | --- |
| `boot/steps/common.py` | Added `validate_kubeadm_token()` utility |
| `boot/steps/wk/join_cluster.py` | Validates token after SSM retrieval |
| `boot/steps/worker.py` | Validates token after SSM retrieval (legacy path) |
| `boot/steps/cp/kubeadm_init.py` | Validates token after `kubeadm token create` |
| `boot/steps/control_plane.py` | Validates token after `kubeadm token create` (legacy) |
| `boot/steps/control_plane.py` (rotator) | Added bash-side grep validation before SSM write |
| `boot/steps/cp/token_rotator.py` | **New module** — migrated rotator with bash validation |
| `boot/steps/cp/__init__.py` | Wired `step_install_token_rotator()` into modular pipeline |

### 3. Token Rotator Bash Validation

The systemd-triggered rotation script now validates format before
writing to SSM:

```bash
TOKEN=$(kubeadm token create --ttl 24h)

# Validate token format before writing to SSM
if ! echo "$TOKEN" | grep -qE '^[a-z0-9]{6}\.[a-z0-9]{16}$'; then
    echo "ERROR: kubeadm token create returned invalid token: $TOKEN" >&2
    exit 1
fi
```

### 4. Defence-in-Depth Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  CP creates      │──→ │  SSM SecureString │──→ │  Worker reads     │
│  token           │     │  /join-token      │     │  token            │
│                  │     │                  │     │                  │
│  ✓ Validate      │     │                  │     │  ✓ Validate       │
│    before write  │     │                  │     │    before use     │
└─────────────────┘     └──────────────────┘     └──────────────────┘
        │                                                │
        │  ✓ Rotator validates                           │  ✓ Fail fast
        │    every 12h                                   │    with clear
        └────────────────────────────────────────────────│    error msg
```

## Test Coverage

15 unit tests in `tests/boot/test_token_validation.py`:
- Clean passthrough (valid tokens)
- Leading backslash sanitisation (single and multiple)
- Whitespace stripping
- Combined corruption scenarios
- All invalid format rejections (too short, missing dot, uppercase,
  special chars, mid-token backslash)
- Source label in error message verification

## Recovery Procedure

If the token is already corrupted in SSM:

```bash
# SSH to control plane (via SSM Session Manager)
export KUBECONFIG=/etc/kubernetes/admin.conf

# Generate clean token
TOKEN=$(kubeadm token create --ttl 24h)

# Verify format locally
echo "$TOKEN" | grep -qE '^[a-z0-9]{6}\.[a-z0-9]{16}$' && echo "VALID" || echo "INVALID"

# Overwrite in SSM
aws ssm put-parameter \
    --name "/k8s/development/join-token" \
    --value "$TOKEN" \
    --type "SecureString" \
    --overwrite \
    --region eu-west-1
```

Then re-run the failed SSM automation execution.

## Lessons Learnt

1. **Never trust external data boundaries** — SSM SecureString
   values should always be validated and sanitised before use.
2. **Validate at both ends** — the control plane validates before
   writing to SSM, and the worker validates after reading from SSM.
3. **Bash scripts need their own validation** — Python validation
   does not protect the systemd-triggered rotator, which is pure bash.
4. **Include source labels in error messages** — knowing _where_
   the token came from (SSM vs kubeadm) dramatically speeds up
   incident response.
