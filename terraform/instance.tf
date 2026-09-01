############################
# open-videocore instance provisioning (#485)
#
# Provisions the eyevinn-open-videocore service instance. Argument names are
# derived from the OSC service schema (get-service-schema eyevinn-open-videocore)
# combined with the PROVEN paramstore naming convention: a PascalCase service
# config option maps to a snake_case provider argument
# (examples/paramstore/main.tf line 101: config option `RedisUrl` -> arg
# `redis_url`; line 100: `name` -> `name`). The `instance_url` computed output
# attribute follows the same example (lines 117, 131-132).
#
# Schema -> argument mapping (all six required options):
#   name                 (req)             -> name
#   OscAccessToken       (req, sensitive)  -> osc_access_token
#   ParameterStoreApiKey (req)             -> parameter_store_api_key
#   ParameterStore       (req)             -> parameter_store
#   MinioRootPassword    (req, sensitive)  -> minio_root_password
#   CouchdbAdminPassword (req, sensitive)  -> couchdb_admin_password
#
# Optional Encore* options (EncoreMaxInstances/EncoreMinInstances/
# EncoreIdleTimeoutMs) are intentionally omitted — no matching variables are
# declared and defaults apply server-side.
#
# CAVEAT: the exact provider argument names below could NOT be validated with a
# live `terraform validate` — the OSC provider is not installable in this
# environment. They are derived from the OSC service schema plus the proven
# paramstore convention. A reviewer with provider access should confirm.
############################

############################
# Resource: Random passwords
# Mirrors the example random_password block shape (example lines 62-65:
# `length` + `special`).
############################
resource "random_password" "minio" {
  length  = 16
  special = false
}

resource "random_password" "couchdb" {
  length  = 16
  special = false
}

############################
# Resource: open-videocore instance
############################
resource "osc_eyevinn_open_videocore" "this" {
  name = var.open_videocore_name

  # PAT reused as the instance's OscAccessToken — kept simple; the instance
  # calls the OSC API at runtime (POST /api/v1/provision) with the same PAT.
  osc_access_token = var.osc_pat

  # PARAMETER_STORE_API_KEY -> ParameterStoreApiKey -> parameter_store_api_key.
  # Sourced out-of-band via var.parameter_store_api_key (see #484 /
  # terraform/PARAMETER_STORE_API_KEY.md).
  parameter_store_api_key = var.parameter_store_api_key

  # PARAMETER_STORE_INSTANCE_NAME -> ParameterStore -> parameter_store.
  # Wired to the applied `name` attribute of the app-config-svc resource from
  # #483 (paramstore.tf), NOT a hardcoded string.
  parameter_store = osc_eyevinn_app_config_svc.this.name

  # Generated secrets.
  minio_root_password   = random_password.minio.result
  couchdb_admin_password = random_password.couchdb.result

  depends_on = [osc_eyevinn_app_config_svc.this]
}
