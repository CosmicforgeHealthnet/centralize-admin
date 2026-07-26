# Advertising Execution provider access and blockers

Capability is account-specific and fail-closed. A known provider enum, configured API version or structurally implemented adapter never implies write readiness.

Common blockers: master/provider/connection gate false; dry-run or worker disabled; missing/stale connection discovery; inactive or reauthorization-required connection; missing OAuth scope/account role/developer access tier; mismatched account/currency; unavailable operation/campaign/creative/targeting/bidding combination; Page/identity/Spark/funding-instrument requirement; unapproved regulated category; expired preflight/approval; changed before-state; malware/destination/accessibility failure; provider rate limit; unknown outcome pending reconciliation.

Provider-specific checks are defined in `adapters/provider-definitions.js`, capability discovery and provider adapters. Live readiness is intentionally unconfirmed until approved sandbox credentials and accounts are exercised. The current implementation performed no live provider request, mutation or media upload, and every write gate remains disabled by default.
