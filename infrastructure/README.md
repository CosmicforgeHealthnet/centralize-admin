# Infrastructure

The backend's existing root-level Docker build is preserved by a compatibility `Dockerfile` at repository root. CI workflow definitions remain in `.github/workflows/`. Full separate microservice deployment manifests, ingress, observability, per-service secrets and service-to-service identity are future work. Do not treat this directory as a deployed infrastructure stack.

The layout guard in `scripts/check-layout.mjs` verifies active app locations and that old root source paths have been removed.
