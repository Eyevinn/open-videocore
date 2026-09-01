############################
# Variables (inputs)
############################

## --- General ---

# Your OSC Personal Access Token (PAT). Sensitive.
variable "osc_pat" {
  type        = string
  sensitive   = true
  description = "Eyevinn OSC Personal Access Token"
}

# Environment: prod | stage | dev
variable "osc_environment" {
  type        = string
  default     = "prod"
  description = "OSC Environment"
}

## --- Instance naming ---

variable "paramstore_name" {
  type        = string
  default     = "ovcconfig"
  description = "Name of the parameter store (app config) solution. Lower case letters and numbers only"
}

variable "open_videocore_name" {
  type        = string
  description = "Name of the open-videocore instance. Lower case letters and numbers only"
}
