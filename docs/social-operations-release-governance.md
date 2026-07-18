# Social Operations Release Governance

Production workflow:

`.github/workflows/production.yml`

Production deployment no longer runs automatically on a normal push to `main`. It requires `workflow_dispatch`.

Source-level protections:

- manual invocation;
- GitHub `production` environment reference;
- production concurrency group;
- no push trigger.

External GitHub environment approval rules are still configured outside source control. No production deployment was performed by this backend closure work.
