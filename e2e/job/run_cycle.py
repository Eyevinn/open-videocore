#!/usr/bin/env python3
"""OSC My Job entrypoint: run one e2e runner cycle.

My Jobs run Python (python-job-runner: 6 h max, one run at a time, no retries, no disk kept between
runs), the runner is Node. So this shim makes sure Node is available, installs the runner's two
dependencies from the lockfile, runs `runner/cli.mjs`, and exits with its exit code
(0 green, 1 red/stale/infra-error, 2 config). Configuration arrives as environment variables injected
from the job's parameter store; nothing is read from or written to disk outside the pod.

Job config:  workerCmd = "python e2e/job/run_cycle.py"   cron = "*/15 * * * *" (UTC)
"""
import os
import shutil
import subprocess
import sys

E2E_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_WHEEL = "nodejs-wheel-binaries==24.19.0"  # bundles Node 24 and npm; the runner needs node >= 22
TARGET = os.environ.get("E2E_NODE_TARGET", "/tmp/e2e-node-wheel")


def log(msg):
    print(f"[e2e-job] {msg}", flush=True)


def node_tools():
    """Return (run_node, run_npm): callables taking an argv list and returning an exit code."""
    node, npm = shutil.which("node"), shutil.which("npm")
    if node and npm:
        log(f"using node on PATH: {node}")
        return (lambda a: subprocess.call([node, *a], cwd=E2E_DIR),
                lambda a: subprocess.call([npm, *a], cwd=E2E_DIR))
    log(f"no node on PATH; installing {NODE_WHEEL} into {TARGET}")
    rc = subprocess.call([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                          "--target", TARGET, NODE_WHEEL])
    if rc != 0:
        log("pip could not install Node (no network or no pip in this runtime?). Cannot run the cycle.")
        sys.exit(70)
    sys.path.insert(0, TARGET)
    from nodejs_wheel import executable  # noqa: E402  (available only after the install above)
    return (lambda a: executable.node(a, cwd=E2E_DIR), lambda a: executable.npm(a, cwd=E2E_DIR))


def main():
    run_node, run_npm = node_tools()
    log("npm ci")
    if run_npm(["ci", "--no-audit", "--no-fund", "--loglevel=error"]) != 0:
        log("npm ci failed")
        return 71
    log("running one cycle")
    return run_node(["runner/cli.mjs"])


if __name__ == "__main__":
    sys.exit(main())
