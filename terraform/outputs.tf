############################
# Outputs
#
# Attribute names mirror the verified example at
# examples/paramstore/main.tf lines 111-136.
############################

## --- Valkey (backing store) ---
output "valkey_external_ip" {
  description = "External IP of the Valkey instance backing the parameter store"
  value       = osc_valkey_io_valkey.this.external_ip
}

output "valkey_external_port" {
  description = "External port of the Valkey instance backing the parameter store"
  value       = osc_valkey_io_valkey.this.external_port
}

output "valkey_instance_url" {
  description = "Instance URL of the Valkey instance backing the parameter store"
  value       = osc_valkey_io_valkey.this.instance_url
}

output "valkey_service_id" {
  description = "Service ID of the Valkey instance backing the parameter store"
  value       = osc_valkey_io_valkey.this.service_id
}

## --- App Config Service (parameter store) ---
# Consumed by the open-videocore instance resource (#485).
output "app_config_svc_external_ip" {
  description = "External IP of the eyevinn-app-config-svc parameter store instance"
  value       = osc_eyevinn_app_config_svc.this.external_ip
}

output "app_config_svc_external_port" {
  description = "External port of the eyevinn-app-config-svc parameter store instance"
  value       = osc_eyevinn_app_config_svc.this.external_port
}

output "app_config_svc_instance_url" {
  description = "Instance URL of the eyevinn-app-config-svc parameter store instance"
  value       = osc_eyevinn_app_config_svc.this.instance_url
}

output "app_config_svc_service_id" {
  description = "Service ID of the eyevinn-app-config-svc parameter store instance"
  value       = osc_eyevinn_app_config_svc.this.service_id
}

## --- open-videocore parameter-store wiring (#485 consumes these) ---
#
# PARAMETER_STORE_INSTANCE_NAME IS derivable from the contract: README.md:126
# defines it as the name of the eyevinn-app-config-svc instance (default
# ovcconfig), and paramstore.tf sets that resource's `name` to
# var.paramstore_name (mirrors example line 100). We surface the resource's
# actual `name` attribute so #485 wires the instance from the applied value.
output "parameter_store_instance_name" {
  description = "Value for PARAMETER_STORE_INSTANCE_NAME on the open-videocore instance (#485). Name of the eyevinn-app-config-svc instance per README.md:126."
  value       = osc_eyevinn_app_config_svc.this.name
}

# PARAMETER_STORE_API_KEY is NOT derivable from the verified provider contract:
# osc_eyevinn_app_config_svc exposes no ConfigApiKey attribute
# (examples/paramstore/main.tf outputs lines 125-136). It is passed in via the
# sensitive var.parameter_store_api_key (obtained out-of-band; see
# terraform/PARAMETER_STORE_API_KEY.md) and re-exported here so #485 wires it as
# PARAMETER_STORE_API_KEY without re-declaring the variable.
output "parameter_store_api_key" {
  description = "Value for PARAMETER_STORE_API_KEY on the open-videocore instance (#485). Sourced out-of-band via var.parameter_store_api_key; see terraform/PARAMETER_STORE_API_KEY.md."
  value       = var.parameter_store_api_key
  sensitive   = true
}

## --- open-videocore instance (#485) ---
# Public URL of the provisioned open-videocore instance. `instance_url` is the
# computed URL attribute exposed by the OSC provider, matching the paramstore
# example convention (examples/paramstore/main.tf lines 117, 131-132).
output "open_videocore_url" {
  description = "Public URL of the open-videocore instance"
  value       = osc_eyevinn_open_videocore.this.instance_url
}
