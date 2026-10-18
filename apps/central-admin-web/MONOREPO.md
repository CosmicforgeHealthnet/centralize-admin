# Central Admin Web (active)

The Next.js frontend moved intact from `frontend/`, retaining dependencies, components, client-side API paths, auth flow, image assets, and lockfile.

Development: `npm ci && npm run dev`. CI: `npm run lint && npx tsc --noEmit && npm run build`. Set `NEXT_PUBLIC_API_URL` to the backend origin at build time. The backend remains a separate service, not part of the frontend runtime.
