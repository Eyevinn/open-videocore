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
