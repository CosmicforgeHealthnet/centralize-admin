# Example only - NOT applied by CI or the application. Review with the
# infrastructure owner, then apply per environment from an approved pipeline:
#   terraform -chdir=infrastructure/mail/storage/terraform plan -var environment=staging
# Creates: a private, versioned, KMS-encrypted mail bucket with public access
# blocked and Object Lock (governance) enabled, plus two KMS keys (keyring
# wrapping key and bucket SSE key) with yearly rotation.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}
variable "region" { type = string }
variable "retention_days" {
  type    = number
  default = 30 # Object Lock governance default; legal holds extend per object.
}

locals {
  bucket = "cosmicforge-mail-${var.environment}-private"
  tags   = { service = "cosmicforge-mail", environment = var.environment }
}

resource "aws_kms_key" "keyring" {
  description             = "CosmicForge Mail keyring wrapping key (${var.environment})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags
}

resource "aws_kms_alias" "keyring" {
  name          = "alias/cosmicforge-mail-${var.environment}"
  target_key_id = aws_kms_key.keyring.key_id
}

resource "aws_kms_key" "bucket_sse" {
  description             = "CosmicForge Mail bucket SSE key (${var.environment})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags
}

resource "aws_s3_bucket" "mail" {
  bucket              = local.bucket
  object_lock_enabled = true
  tags                = local.tags
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket                  = aws_s3_bucket.mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "mail" {
  bucket = aws_s3_bucket.mail.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.bucket_sse.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.retention_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    id     = "expire-health-canaries"
    status = "Enabled"
    filter { prefix = "mail/health/" }
    expiration { days = 1 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter { prefix = "mail/" }
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
}

output "bucket" { value = aws_s3_bucket.mail.bucket }
output "keyring_alias" { value = aws_kms_alias.keyring.name }
output "bucket_sse_key_arn" { value = aws_kms_key.bucket_sse.arn }
