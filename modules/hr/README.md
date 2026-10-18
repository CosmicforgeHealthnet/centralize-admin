# hr domain boundary

**Ownership map only; not a separate runtime or imported package.** Today's backend implementation remains under `services/central-admin-api/src/modules/` (related implementation: hrm). Corresponding frontend routes and UI remain under `apps/central-admin-web/src/`. Moving code into a shared business-domain module requires dependency/permissions review and coverage first.
