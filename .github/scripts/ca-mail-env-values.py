#!/usr/bin/env python3
"""Assemble the Mail settings to install for one target, on the GitHub runner.

Used by .github/workflows/ca-mail-env-install.yml. Never prints a value:
the assembled KEY=value lines go to stdout (piped straight into the SSH
session), and only key NAMES and their source go to stderr.

Sources, in order (a later source overrides an earlier one):
  1. production: CA_PRODUCTION_MAIL_ENV only (unchanged behaviour).
     staging:    the committed, secret-free profile
                 infrastructure/mail/env/staging.env, then CA_STAGING_MAIL_ENV.
  2. credentials=shared-from-production (staging only): RESEND_API_KEY and
     RESEND_WEBHOOK_SECRET, and nothing else, are taken from
     CA_PRODUCTION_MAIL_ENV. One Resend account and one webhook serve both
     deployments, so these two values are the same by design; every other
     setting stays staging's own. The staging secret must then not carry
     either key, so it is never ambiguous which one was installed.

Environment: TARGET, CREDENTIALS (secret | shared-from-production), FLAGS,
STAGING_VALUES, PRODUCTION_VALUES, PROFILE (path).
Exit 1 with a names-only reason on any problem.
"""
import os
import re
import sys

KEY = re.compile(r'^(MAIL|RESEND)_[A-Z0-9_]+$')
SHARED = ('RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET')


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def parse(text, source):
    values = {}
    for n, raw in enumerate((text or '').splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        key, sep, value = raw.partition('=')
        key = key.strip()
        if not sep or not KEY.fullmatch(key):
            fail(f'{source} line {n}: key not allowed (only MAIL_* / RESEND_*)')
        if key in values:
            fail(f'{source}: {key} given twice')
        values[key] = value.strip()
    return values


def main():
    target = os.environ.get('TARGET', '')
    credentials = os.environ.get('CREDENTIALS', 'secret') or 'secret'
    staging = os.environ.get('STAGING_VALUES', '')
    production = os.environ.get('PRODUCTION_VALUES', '')
    if target not in ('staging', 'production'):
        fail('target must be staging or production')
    if credentials not in ('secret', 'shared-from-production'):
        fail('provider_credentials must be secret or shared-from-production')

    if target == 'production':
        if credentials != 'secret':
            fail('provider_credentials=shared-from-production applies to staging only')
        merged = parse(production, 'CA_PRODUCTION_MAIL_ENV')
        sources = {key: 'CA_PRODUCTION_MAIL_ENV' for key in merged}
    else:
        profile_path = os.environ.get('PROFILE', '')
        profile = parse(open(profile_path, encoding='utf-8').read(), 'staging profile') if profile_path and os.path.isfile(profile_path) else {}
        if any(key.startswith('RESEND_') for key in profile):
            fail('the committed staging profile must not contain RESEND_* keys')
        own = parse(staging, 'CA_STAGING_MAIL_ENV')
        merged = dict(profile)
        sources = {key: 'staging profile' for key in profile}
        for key, value in own.items():
            merged[key] = value
            sources[key] = 'CA_STAGING_MAIL_ENV'
        if credentials == 'shared-from-production':
            clash = [key for key in SHARED if key in own]
            if clash:
                fail(f'CA_STAGING_MAIL_ENV contains {", ".join(clash)}: remove it or use provider_credentials=secret')
            shared = parse(production, 'CA_PRODUCTION_MAIL_ENV')
            missing = [key for key in SHARED if not shared.get(key)]
            if missing:
                fail(f'CA_PRODUCTION_MAIL_ENV has no {", ".join(missing)} to share')
            for key in SHARED:
                merged[key] = shared[key]
                sources[key] = 'CA_PRODUCTION_MAIL_ENV (shared)'
        if not own and credentials != 'shared-from-production' and not os.environ.get('FLAGS', '').strip():
            fail('Secret CA_STAGING_MAIL_ENV is empty and no flags were given. Add it, or use provider_credentials=shared-from-production.')

    if merged.get('MAIL_DEPLOYMENT_ENV', target) != target:
        fail(f'MAIL_DEPLOYMENT_ENV must be {target} for this target')
    for key in sorted(merged):
        print(f'{key}={merged[key]}')
    print('Settings to install (names and source only):', file=sys.stderr)
    for key in sorted(merged):
        print(f'  {key}: {sources[key]}', file=sys.stderr)


if __name__ == '__main__':
    main()
