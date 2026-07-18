# Social Media Operations Module

This module is the future home of the CosmicForge Social Media Operations backend. Step 1 creates only the architecture shell and Prisma enums. It intentionally does not register routes, create database models, run migrations, or implement provider logic.

## Directory Layout

```text
src/modules/marketing/social-operations/
|-- accounts/
|-- oauth/
|-- connectors/
|-- content/
|-- media/
|-- approvals/
|-- publishing/
|-- actions/
|-- inbox/
|-- community/
|-- webhooks/
|-- analytics/
|-- scheduling/
|-- settings/
`-- index.js
```

## Architecture Rules

1. Controllers parse input, apply RBAC, call one service operation and shape responses.
2. Controllers never call Prisma directly.
3. Controllers never call providers directly.
4. Services own transactions.
5. Provider HTTP calls never run inside an open Prisma transaction.
6. Connectors are the only files allowed to import provider SDKs or hardcode provider API base URLs.
7. `publishing-orchestrator.service.js` will be the only caller of `connector.publishPost`.
8. `action-orchestrator.service.js` will be the only caller of non-publishing provider writes: send message, reply to comment, hide comment, delete comment, delete provider post, and provider synchronization.
9. `webhook-event.service.js` will be the only writer of normalized provider-event records.
10. Connectors normalize provider payloads but never persist them.

Provider connectors, orchestrators, routes, persistence, jobs, OAuth, media upload, settings persistence, inbox, community, analytics, scheduling, and webhooks are deliberately left for later specification sections.
