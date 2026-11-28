# Managed by .github/scripts/ca-host-ops.sh --nginx-upload-apply (template:
# infrastructure/mail/nginx/ca-mail-upload-limits.conf.tpl). Included inside ONE
# Central Admin API server block (staging and production each get their own
# generated file). The body placeholder inside each location below is replaced
# with the proxy directives of that block's own proxied `location /` (proxy_pass
# and any proxy_set_header), minus the directives set below, so the upload paths
# are proxied exactly like every other path; nothing else is changed.
#
# Nginx's built-in client_max_body_size is 1m: larger uploads are answered by
# Nginx itself with a bare HTML 413 and never reach the API. The API owns the
# real limits (MAIL_ATTACHMENT_MAX_BYTES default 10 MiB / hard max 25 MiB,
# MAIL_MESSAGE_MAX_BYTES) and returns structured errors; this proxy ceiling is
# above the largest value the API can be configured to accept plus multipart
# overhead. All other routes keep the global/default limit.

# POST /api/mail/v1/drafts/:draftId/attachments (multipart, one file)
location ~ ^/api/mail/v1/drafts/[^/]+/attachments$ {
    client_max_body_size 26m;
    client_body_timeout 120s;
    error_page 413 @ca_mail_upload_too_large;
    __LOCATION_BODY__
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}

# POST /api/mail/v1/marketing/:orgId/contacts/import (CSV, API limit 2 MiB)
location ~ ^/api/mail/v1/marketing/[^/]+/contacts/import$ {
    client_max_body_size 3m;
    client_body_timeout 60s;
    error_page 413 @ca_mail_upload_too_large;
    __LOCATION_BODY__
    proxy_read_timeout 60s;
}

# A body above the proxy ceiling never reaches the API, so the API cannot add
# CORS headers; without them the browser hides the 413 and reports a CORS
# failure. Answer with JSON (no API `code`, so the web app shows its "gateway
# rejected this file as too large" message) and echo the Origin ONLY for the
# exact trusted Admin origins the API itself allows
# (services/central-admin-api/src/shared/config/cors-origins.js). Never `*`.
location @ca_mail_upload_too_large {
    default_type application/json;
    set $ca_mail_cors_origin "";
    set $ca_mail_cors_credentials "";
    if ($http_origin ~ "^https://(centralize-admin\.vercel\.app|centralize-admin\.cosmiforgegroup\.cloud|centralize-admin-staging\.vercel\.app|centralize-admin-staging-cosmicforgedevteamgmailcoms-projects\.vercel\.app|centralize-admin-[a-z0-9]+-cosmicforgedevteamgmailcoms-projects\.vercel\.app)$") {
        set $ca_mail_cors_origin $http_origin;
        set $ca_mail_cors_credentials "true";
    }
    add_header Access-Control-Allow-Origin $ca_mail_cors_origin always;
    add_header Access-Control-Allow-Credentials $ca_mail_cors_credentials always;
    add_header Vary Origin always;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff" always;
    return 413 '{"success":false,"retryable":false,"message":"The upload is larger than the Mail gateway accepts.","errors":[{"reason":"GATEWAY_BODY_TOO_LARGE","maxBytes":27262976}]}';
}
