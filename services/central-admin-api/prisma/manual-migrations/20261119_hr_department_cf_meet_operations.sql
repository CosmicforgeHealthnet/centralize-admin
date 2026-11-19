-- HR department for CF Meet operations staff (docs/product-admin/
-- cfmeet-admin-design.md section 2 and section 7). Additive only: adds one
-- value to the existing "Department" enum and changes no rows. CF Meet product
-- access stays governed by HQ product grants, not by this department.
-- PostgreSQL cannot drop an enum value; rollback is to stop assigning it
-- (no row uses it until HR assigns the department).
ALTER TYPE "Department" ADD VALUE IF NOT EXISTS 'CF_MEET_OPERATIONS';
