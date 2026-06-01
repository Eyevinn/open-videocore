# open-videocore — Infrastructure

OSC service provisioning scripts for open-videocore.

## Scripts

| Script | Purpose |
|--------|---------|
| `provision-dev.sh` | Provision all OSC dev-tier service instances and parameter store |
| `teardown-dev.sh` | Delete all dev-tier instances (use with care) |

## Usage

```bash
# Provision from scratch (idempotent)
./provision-dev.sh

# Check status of all instances
./status.sh
```

Requires `gh` and the OSC MCP CLI. All connection strings land in the `openvideocore` parameter store.

## Services provisioned

See [../docs/architecture/ADR-001-osc-stack.md](../docs/architecture/ADR-001-osc-stack.md) for the full service list and rationale.
