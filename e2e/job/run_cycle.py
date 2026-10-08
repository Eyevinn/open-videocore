#!/usr/bin/env python3
"""OSC My Job entrypoint: run one e2e runner cycle.

My Jobs run Python (python-job-runner: 6 h max, one run at a time, no retries, no disk kept between
runs), the runner is Node. So this shim makes sure Node is available, installs the runner's two
dependencies from the lockfile, runs `runner/cli.mjs`, and exits with its exit code
(0 green, 1 red/stale/infra-error, 2 config). Configuration arrives as environment variables injected
from the job's parameter store; nothing is read from or written to disk outside the pod.

Job config:  workerCmd = "python e2e/job/run_cycle.py"   cron = "*/15 * * * *" (UTC)
"""
import atexit
import datetime
import hashlib
import hmac
import os
import shutil
import subprocess
import sys
import traceback
import urllib.parse
import urllib.request

E2E_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_WHEEL = "nodejs-wheel-binaries==24.19.0"  # bundles Node 24 and npm; the runner needs node >= 22
TARGET = os.environ.get("E2E_NODE_TARGET", "/tmp/e2e-node-wheel")


# --- Diagnostics -------------------------------------------------------------------------------------------------
# The job platform gives us no way to read a run's output, so this script reports on itself: a timestamped step log
# is written to results/diag/last-run.txt in the results bucket after every step, using only the standard library
# (a hand-rolled SigV4 PUT) so it works even when installing Node fails. Values of secret-looking variables are
# masked; only variable NAMES are listed. If no diag file appears after a run, the script never started, or the
# S3 variables never reached the environment.
_LOG = []
_SECRET_KEYS = ("TOKEN", "PASSWORD", "SECRET", "KEY")


def _secrets():
    return [v for k, v in os.environ.items() if v and len(v) >= 6 and any(m in k.upper() for m in _SECRET_KEYS)]


def _mask(text):
    for v in _secrets():
        text = text.replace(v, "[redacted]")
    return text


def _sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def s3_put(endpoint, bucket, key, body, access, secret, region="us-east-1"):
    """Minimal AWS SigV4 PUT, path-style. Returns the HTTP status."""
    host = urllib.parse.urlparse(endpoint).netloc
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate, datestamp = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    uri = "/" + bucket + "/" + urllib.parse.quote(key)
    payload_hash = hashlib.sha256(body).hexdigest()
    signed = "host;x-amz-content-sha256;x-amz-date"
    canonical = "\n".join(["PUT", uri, "", f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amzdate}\n", signed, payload_hash])
    scope = f"{datestamp}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = _sign(_sign(_sign(_sign(("AWS4" + secret).encode(), datestamp), region), "s3"), "aws4_request")
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(endpoint.rstrip("/") + uri, data=body, method="PUT", headers={
        "x-amz-date": amzdate, "x-amz-content-sha256": payload_hash, "content-type": "text/plain",
        "authorization": f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={signature}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


def flush():
    """Best effort: never let diagnostics change the job's outcome."""
    env = os.environ
    try:
        if all(env.get(k) for k in ("E2E_S3_ENDPOINT", "E2E_S3_BUCKET", "E2E_S3_ACCESS_KEY", "E2E_S3_SECRET_KEY")):
            body = _mask("\n".join(_LOG)).encode()
            s3_put(env["E2E_S3_ENDPOINT"], env["E2E_S3_BUCKET"], "results/diag/last-run.txt", body,
                   env["E2E_S3_ACCESS_KEY"], env["E2E_S3_SECRET_KEY"])
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "code", "")
        print(f"[e2e-job] could not write diagnostics: {type(e).__name__} {code}".rstrip(), flush=True)


def log(msg):
    line = f"{datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S')} {msg}"
    _LOG.append(line)
    print(f"[e2e-job] {_mask(msg)}", flush=True)
    flush()


def run_logged(argv, **kw):
    """Run a command, capture its tail into the diag log, return its exit code."""
    p = subprocess.run(argv, capture_output=True, text=True, **kw)
    tail = (p.stdout + p.stderr).strip().splitlines()[-12:]
    log(f"  exit={p.returncode}; last output: " + " | ".join(t[:160] for t in tail))
    return p.returncode


def _record(p):
    tail = (p.stdout + p.stderr).strip().splitlines()[-14:]
    log(f"  exit={p.returncode}; last output: " + " | ".join(t[:160] for t in tail))
    return p.returncode


def node_tools():
    """Return (run_node, run_npm): callables taking an argv list and returning an exit code; output is logged."""
    node, npm = shutil.which("node"), shutil.which("npm")
    if node and npm:
        log(f"using node on PATH: {node}")
        return (lambda a: _record(subprocess.run([node, *a], cwd=E2E_DIR, capture_output=True, text=True)),
                lambda a: _record(subprocess.run([npm, *a], cwd=E2E_DIR, capture_output=True, text=True)))
    log(f"no node on PATH; installing {NODE_WHEEL} into {TARGET}")
    rc = run_logged([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--target", TARGET, NODE_WHEEL])
    if rc != 0:
        log("pip could not install Node (no network or no pip in this runtime?). Cannot run the cycle.")
        sys.exit(70)
    sys.path.insert(0, TARGET)
    from nodejs_wheel import executable  # noqa: E402  (available only after the install above)
    return (lambda a: _record(executable.node(a, return_completed_process=True, capture_output=True, text=True, cwd=E2E_DIR)),
            lambda a: _record(executable.npm(a, return_completed_process=True, capture_output=True, text=True, cwd=E2E_DIR)))


def environment_facts():
    names = sorted(k for k in os.environ if k.startswith(("E2E_", "OSC_", "GITHUB_", "PATH")))
    log(f"python {sys.version.split()[0]} on {sys.platform}; cwd={os.getcwd()}; script={os.path.abspath(__file__)}")
    log(f"e2e dir {E2E_DIR}: package.json={os.path.exists(os.path.join(E2E_DIR, 'package.json'))}, "
        f"package-lock.json={os.path.exists(os.path.join(E2E_DIR, 'package-lock.json'))}, "
        f"runner/cli.mjs={os.path.exists(os.path.join(E2E_DIR, 'runner', 'cli.mjs'))}")
    log("environment variable NAMES present (values never logged): " + ", ".join(names))
    wanted = ["E2E_S3_ENDPOINT", "E2E_S3_BUCKET", "E2E_S3_ACCESS_KEY", "E2E_S3_SECRET_KEY", "E2E_SOURCE_URL", "OSC_ACCESS_TOKEN",
              "E2E_INSTANCE_OSC_ACCESS_TOKEN", "E2E_PARAMETER_STORE", "E2E_PARAMETER_STORE_API_KEY", "E2E_MINIO_ROOT_PASSWORD",
              "E2E_COUCHDB_ADMIN_PASSWORD"]
    # A fingerprint (length + first 10 hex of SHA-256) lets a run's value be compared with the intended one without
    # revealing it. The endpoint and bucket are not secret and are shown as they arrive.
    for k in ("E2E_S3_ENDPOINT", "E2E_S3_BUCKET"):
        log(f"{k} = {os.environ.get(k)!r}")
    for k in ("E2E_S3_ACCESS_KEY", "E2E_S3_SECRET_KEY"):
        v = os.environ.get(k)
        log(f"{k}: " + ("unset" if v is None else f"len={len(v)} sha256[:10]={hashlib.sha256(v.encode()).hexdigest()[:10]} "
                         f"has_whitespace={v != v.strip() or any(c.isspace() for c in v)}"))
    missing = [k for k in wanted if not os.environ.get(k)]
    log("required variables missing: " + (", ".join(missing) if missing else "none"))


def main():
    atexit.register(flush)
    environment_facts()
    run_node, run_npm = node_tools()
    log("npm ci")
    if run_npm(["ci", "--no-audit", "--no-fund", "--loglevel=error"]) != 0:
        log("npm ci failed")
        return 71
    log("running one cycle")
    rc = run_node(["runner/cli.mjs"])
    log(f"cycle finished with exit code {rc}")
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001  (record any crash before the interpreter exits)
        log("unhandled exception: " + traceback.format_exc()[-700:])
        sys.exit(72)
