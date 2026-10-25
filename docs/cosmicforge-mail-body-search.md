# CosmicForge Mail body search: design, threat model and approval

Specification: sections 5.1 ("search by sender, recipient, subject, body and
date") and 12 ("plan encrypted body/search index leakage assessment; adopt
external search only with approved data-processing posture").

## What is built

Body search is a **keyed blind index** stored in the Admin database
(`mail_message_search_index`, migration 35). It is **off by default**.

- Message bodies stay in encrypted private object storage (AES-256-GCM, KMS
  data keys). The index never holds plaintext words, snippets or bodies.
- Each distinct word of a body (lower-cased, Unicode-normalized, accents
  removed, 2-40 characters, at most 2,000 per message) is stored as
  `HMAC-SHA256(mailboxKey, word)` truncated to 96 bits.
- `mailboxKey = HMAC-SHA256(searchKey, "cosmicforge-mail-search:v1:mailbox:" + mailboxId)`.
  The same word therefore produces unrelated terms in different mailboxes.
- `searchKey` comes from `MAIL_SEARCH_INDEX_KEYS` (`s1:<base64 32 bytes>`,
  one or more versions; `MAIL_SEARCH_INDEX_ACTIVE_KEY` selects the active one).
  It is separate from the content encryption keys and lives only in the API's
  secret store. It is never logged or returned by the API.
- A search computes terms only for the mailboxes the caller may read, and the
  SQL restricts results to those mailbox ids (authorization is in the query,
  not applied afterwards). Unified search covers member mailboxes only; a
  break-glass grant allows searching that single mailbox explicitly, and every
  such search is audited (`MAIL_BREAK_GLASS_SEARCH`, query text not logged).
- Each query word must appear in the message's metadata (subject, sender,
  non-BCC recipients) or its body. Whole words only; no prefixes.
- Index rows are written in the same transaction as the message, removed with
  it by retention, and rebuilt by `SEARCH_INDEX_BACKFILL` (IT > Mail
  Administration > Forwarding & recovery > "Index now", or
  `POST /api/mail/v1/admin/search-index/backfill`). Freshness is exported as
  `cf_mail_search_unindexed` and alerted as `MAIL_SEARCH_INDEX_STALE`.

## Threat model

| Adversary | What they get |
|---|---|
| Another employee, a mail admin or SUPER using the API | Nothing: results, counts, snippets and errors are scoped to authorized mailboxes; a foreign mailbox id returns 404. Tested. |
| Database read access only (backup, replica, SQL injection) | Per message: number of distinct words and opaque terms. Within one mailbox, which messages share a word (unknown which word). No cross-mailbox linkage. No plaintext. |
| Database copy **and** the search key | Can confirm guessed words per mailbox (dictionary attack). Bodies themselves still need the content keys. |
| Search key only | Nothing without the database. |

Accepted residual leakage (needs approval): the within-mailbox equality and
frequency pattern above, and dictionary confirmation if both the database and
the search key are compromised. Mitigations: separate key from content keys,
key rotation (new active version + backfill, then remove the old version),
the existing database access controls and backup encryption.

Rejected alternatives: a plaintext PostgreSQL full-text index of bodies (a
database read would expose message content; the previous plaintext column was
removed for that reason), and an external search service (not approved for
private mail data processing).

## Operating it

1. Security/privacy owner approves this document (it is a confidentiality
   trade-off). Until then keep `MAIL_BODY_SEARCH_ENABLED=false`.
2. Generate a key: `node -e "console.log('s1:'+require('crypto').randomBytes(32).toString('base64'))"`
   and store it in the secret manager as `MAIL_SEARCH_INDEX_KEYS` (separately
   per environment).
3. Set `MAIL_BODY_SEARCH_ENABLED=true`, deploy, then run "Index now" once to
   index existing mail. New mail is indexed as it arrives.
4. Rotation: add `s2:<new key>` to `MAIL_SEARCH_INDEX_KEYS`, set
   `MAIL_SEARCH_INDEX_ACTIVE_KEY=s2`, run the backfill until
   `/admin/search-index` shows 0 unindexed, then remove `s1`.
5. Turning it off: set the flag to false; search falls back to metadata.
   Optionally delete the rows (`TRUNCATE` is not needed: retention removes them
   with their messages; the gap-closure rollback drops the table).
