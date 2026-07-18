# Social Operations Media Storage

Social Operations now uses a provider-neutral storage interface under `src/modules/marketing/social-operations/media/storage`.

Implemented adapters:

- `local`: development and test only. Files are written outside the repository, use generated safe keys, reject traversal and absolute user paths, and return `local://social-media/...` metadata URLs only for local application behavior.
- `cloudinary`: production-capable adapter using the Cloudinary Node SDK. It validates `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`, uploads bounded buffers through `upload_stream`, requires `secure_url`, stores `public_id` as `storageKey`, and strips secret-shaped provider metadata.

Required variables:

- `SOCIAL_MEDIA_STORAGE_PROVIDER`
- `SOCIAL_LOCAL_MEDIA_STORAGE_DIR`
- `SOCIAL_CLOUDINARY_FOLDER_PREFIX`
- `SOCIAL_MEDIA_UPLOAD_TIMEOUT_MS`
- `SOCIAL_MEDIA_IMAGE_MAX_BYTES`
- `SOCIAL_MEDIA_VIDEO_MAX_BYTES`
- `SOCIAL_MEDIA_ALLOWED_IMAGE_MIME_TYPES`
- `SOCIAL_MEDIA_ALLOWED_VIDEO_MIME_TYPES`
- `SOCIAL_REMOTE_MEDIA_ALLOWED_HOSTS`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Upload flow:

1. Authenticate and authorize through existing Social Operations route middleware.
2. Validate the owner `AdminUser`.
3. Validate MIME type and size.
4. Compute SHA-256 checksum.
5. Reuse an existing non-deleted asset for the same owner/checksum.
6. Upload through the selected adapter.
7. Persist `SocialMediaAsset` only after successful upload.
8. If persistence fails after upload, attempt compensating provider deletion and write safe audit evidence.

Remote URL ingestion must use the existing SSRF-safe fetch path. Cloudinary is not allowed to fetch arbitrary user-supplied URLs directly.

Deletion flow:

1. Check active target/publication references.
2. Delete provider storage idempotently where the provider supports it.
3. Mark the asset `DELETED`.
4. Write safe audit metadata without URLs, payloads, or credentials.

Live Cloudinary verification remains pending because real staging Cloudinary credentials and provider access were intentionally out of scope.
