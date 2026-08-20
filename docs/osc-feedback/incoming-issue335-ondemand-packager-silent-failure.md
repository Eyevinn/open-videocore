# OSC friction: on-demand packager instance is invisible in stack inventory + no create observability

- Date: 2026-08-20
- Context: issue #335 (on-demand packager provisioning fails silently)
- Services: `eyevinn-encore-packager`, `eyevinn-app-config-svc` (parameter store)

## What happened

On the affected tenant, the on-demand packager provisioning path (epic #226 /
issue #244, `src/services/packager-provisioning.ts:ensurePackagerProvisioned`)
never created a packager instance. The parameter store listed only three
services (object store, document store, key-value store) and no packager. No
error was raised and nothing was logged, so the failure was invisible until
packaging hung.

## Root cause (in our code, but rooted in an OSC modelling gap)

Two things combined:

1. The `ensurePackaging` closure in `src/main.ts` treated an unresolvable stack
   (param-store read error, or missing MinIO endpoint) as a soft skip: it
   warn-logged and returned without provisioning. So any transient
   `eyevinn-app-config-svc` read failure silently disabled packager creation.
   Fixed in this change: the resolution now throws so the pipeline `package`
   step transitions to `failed` with a cause.

2. The packager instance is deliberately NOT part of `STACK_SERVICES` (it is
   provisioned lazily), so it was never written into the stack's `services[]`
   inventory in the parameter store. There is no OSC-native "list all instances
   belonging to logical stack X" query — the only stack inventory we have is the
   `services[]` array we maintain ourselves in `eyevinn-app-config-svc`. Because
   the on-demand path did not append the packager to that array, the inventory
   never reflected reality even on a successful create. Fixed here by appending
   `{ serviceId: 'eyevinn-encore-packager', instanceName: <stackName> }` to
   `services[]` after a successful create.

## OSC gap

- There is no platform-level notion of a "stack" / instance grouping, so a
  service instance provisioned outside our eager provisioning path is invisible
  to any inventory that is not hand-maintained. A first-class instance-tagging
  or grouping API (e.g. tag an instance with a stack label and query
  `list-instances-by-tag`) would let the inventory be derived from OSC ground
  truth instead of a parameter-store array we must remember to update on every
  lazy-provision path.
- `create-service-instance` provides no structured failure signal we can key
  on other than the error message string (we string-match `already taken` /
  `already exists` for idempotency). A stable, typed conflict/error code would
  make the ground-truth reconciliation less brittle.

## Mitigation shipped

- `ensurePackagerProvisioned` now logs attempt / ready / failure phases (each
  tagged with the stack name + serviceId) and rethrows create / readiness /
  inventory-record failures so they surface as a terminal `failed` package step.
- The created packager is appended to the stack's `services[]` inventory so the
  inventory reflects reality and deprovision can see it.
