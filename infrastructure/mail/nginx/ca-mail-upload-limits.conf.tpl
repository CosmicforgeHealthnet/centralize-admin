# Managed by .github/scripts/ca-host-ops.sh --nginx-upload-apply (template:
# infrastructure/mail/nginx/ca-mail-upload-limits.conf.tpl). Included inside the
# Central Admin API server block ONLY. __UPSTREAM__ is read from that block's
# own `location /` proxy_pass; nothing else is changed.
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
    proxy_pass __UPSTREAM__;
    proxy_http_version 1.1;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}

# POST /api/mail/v1/marketing/:orgId/contacts/import (CSV, API limit 2 MiB)
location ~ ^/api/mail/v1/marketing/[^/]+/contacts/import$ {
    client_max_body_size 3m;
    client_body_timeout 60s;
    proxy_pass __UPSTREAM__;
    proxy_http_version 1.1;
    proxy_read_timeout 60s;
}
