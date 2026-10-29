# Mail recovery public keys

Put the owner's **public** RSA recovery keys here as `staging.pub` and `production.pub`.
Keys must be 3072 bits or more; 4096 is recommended. See `docs/cosmicforge-mail-go-live.md`
section 2.

`storage-setup` seals each environment's Mail keyring to its key. The result is the
escrow, and every backup carries it. Only the matching private key, kept offline by the
owner, can recover the keys.

Never commit a private key.
