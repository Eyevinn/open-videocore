# Obtaining `PARAMETER_STORE_API_KEY` (out-of-band)

> Focused note for issue #484. The full module README is owned by #486; this
> file documents only the out-of-band step for the parameter-store API key.

## Why this is manual

The open-videocore instance (#485) requires the environment variable
`PARAMETER_STORE_API_KEY`, defined in the app's top-level `README.md:125` as the
**`ConfigApiKey` of the `eyevinn-app-config-svc` instance**.

The verified OSC Terraform provider (`registry.terraform.io/EyevinnOSC/osc`
version `0.5.0`) does **not** expose this key. The `osc_eyevinn_app_config_svc`
resource surfaces only `external_ip`, `external_port`, `instance_url`, and
`service_id` — see the verified example
`examples/paramstore/main.tf` outputs at lines 125-136. There is **no**
`ConfigApiKey` / `config_api_key` attribute on the resource, and there is **no**
companion `osc_*` data source in the provider examples that yields it (a
tree-wide grep for `data "osc_` returns no matches; every `api_key` hit in the
examples is an unrelated `osc_secret`-backed WHIP/SMB key).

Because the key cannot be read from the applied state, Terraform cannot derive
it. It must be obtained out-of-band and passed in via the sensitive input
variable `parameter_store_api_key`.

This gap is logged as OSC provider friction in the agents repo at
`docs/osc-feedback/incoming-terraform-config-api-key-output-gap.md`.

## How to obtain the key

The `ConfigApiKey` is created when the `eyevinn-app-config-svc` instance is
provisioned. Retrieve it out-of-band using either:

- **OSC MCP** — call `describe-service-instance` for the
  `eyevinn-app-config-svc` instance named by `var.paramstore_name` (default
  `ovcconfig`) and read the `ConfigApiKey` field from the instance details; or
- **OSC console** — open the `eyevinn-app-config-svc` instance in
  [app.osaas.io](https://app.osaas.io) and copy its Config API Key.

## How to pass it to Terraform

Supply the key as the sensitive variable — never commit it:

```bash
terraform apply -var 'parameter_store_api_key=<ConfigApiKey>'
```

or via an environment variable:

```bash
export TF_VAR_parameter_store_api_key=<ConfigApiKey>
terraform apply
```

## Wiring for the open-videocore instance (#485)

This module exposes both values #485 needs:

| Instance env var                | Terraform source                                        | Contract cite            |
|---------------------------------|---------------------------------------------------------|--------------------------|
| `PARAMETER_STORE_API_KEY`       | `var.parameter_store_api_key` (output of same name)     | `README.md:125`          |
| `PARAMETER_STORE_INSTANCE_NAME` | `osc_eyevinn_app_config_svc.this.name` (output `parameter_store_instance_name`) | `README.md:126` |

`PARAMETER_STORE_INSTANCE_NAME` **is** derivable from the contract: the
resource's `name` is set from `var.paramstore_name` in `paramstore.tf`
(mirrors example line 100), and defaults to `ovcconfig` per `README.md:126`.
Only the API key requires the out-of-band step above.
