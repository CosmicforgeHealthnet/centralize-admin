#!/usr/bin/python3 -I
"""Initialize only a brand-new dedicated staging database, using pre-provisioned
root-owned local credentials. Never modify an existing database or its roles."""
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, unquote

ROOT = Path("/etc/cosmicforge/staging")
SERVICES = {"karryam": ("karryam-admin", "KARRYAM_ADMIN", "karryam_admin"),
            "cfmeet": ("cfmeet-admin", "CFMEET_ADMIN", "cfmeet_admin")}

def credentials(file, key, role, host, database, *, new_role=False):
    st = file.lstat()
    if file.is_symlink() or st.st_uid != 0 or st.st_mode & 0o037:
        raise ValueError("unsafe config file")
    vals = [line.split("=", 1)[1] for line in file.read_text().splitlines() if line.startswith(key+"=")]
    if len(vals) != 1:
        raise ValueError("missing or duplicate config key")
    url = urlsplit(vals[0])
    if (url.scheme not in ("postgres", "postgresql") or url.username != role
            or url.hostname != host or url.port not in (None, 5432)
            or url.path != "/" + database or url.fragment or url.query not in ("", "sslmode=disable", "sslmode=require") or not url.password):
        raise ValueError("database credential does not match dedicated staging database")
    value = unquote(url.password)
    if new_role and not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", value):
        raise ValueError("unsupported password format for automatic initial provisioning")
    return value

def run_sql(container, service, sql):
    command = ["docker", "exec", "-i", container, "sh", "-c",
               'PGPASSWORD="$(cat /run/secrets/' + service + '-db/postgres-password)" exec psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -tA']
    # SQL contains secrets; never print command output or exception details.
    r = subprocess.run(command, input=sql, text=True, capture_output=True, check=False)
    if r.returncode:
        raise ValueError("dedicated database bootstrap SQL failed")
    return r.stdout.strip()

def main():
    try:
        if os.geteuid() != 0 or len(sys.argv) != 2:
            raise ValueError("unsupported database")
        arg=sys.argv[1]
        if arg.startswith("validate-"):
            kind=arg.removeprefix("validate-")
            if kind=="pic":
                service,prefix,name,host,role="product-integration-core","PIC","cosmicforge_admin","hq-db","pic"
            elif kind in SERVICES:
                service,prefix,name=SERVICES[kind]
                host,role=service+"-db",name
            else:
                raise ValueError("unsupported validation target")
            mp=credentials(ROOT/(service+".migrate.env"),prefix+"_MIGRATION_DATABASE_URL",role+"_migrator",host,name)
            rp=credentials(ROOT/(service+".env"),prefix+"_DATABASE_URL",role+"_runtime",host,name)
            if mp==rp:
                raise ValueError("runtime and migration passwords must differ")
            print("Validated staging credential targets: "+service)
            return
        if arg not in SERVICES:
            raise ValueError("unsupported database")
        service, prefix, name = SERVICES[arg]
        container = "cf-product-admin-staging-" + service + "-db-1"
        label = subprocess.check_output(["docker","inspect","-f",'{{index .Config.Labels "com.docker.compose.project"}}',container],text=True).strip()
        if label != "cf-product-admin-staging":
            raise ValueError("wrong database project")
        migrator, runtime = name+"_migrator", name+"_runtime"
        host = service+"-db"
        existing = run_sql(container, service,
            "SELECT (SELECT count(*) FROM pg_database WHERE datname='"+name+"') || ':' || (SELECT count(*) FROM pg_roles WHERE rolname IN ('"+migrator+"','"+runtime+"'));\n")
        if existing == "1:2":
            print("Existing dedicated database and roles retained: "+service)
            return
        if existing != "0:0":
            raise ValueError("partial existing database/role state; refusing mutation")
        mp = credentials(ROOT/(service+".migrate.env"),prefix+"_MIGRATION_DATABASE_URL",migrator,host,name,new_role=True)
        rp = credentials(ROOT/(service+".env"),prefix+"_DATABASE_URL",runtime,host,name,new_role=True)
        if mp == rp:
            raise ValueError("runtime and migration passwords must differ")
        sql = ("BEGIN;\nCREATE ROLE "+migrator+" LOGIN PASSWORD '"+mp+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;\n"
               +"CREATE ROLE "+runtime+" LOGIN PASSWORD '"+rp+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;\nCOMMIT;\n"
               +"CREATE DATABASE "+name+" OWNER "+migrator+";\nREVOKE ALL ON DATABASE "+name+" FROM PUBLIC;\nGRANT CONNECT ON DATABASE "+name+" TO "+runtime+";\n"
               +"\\connect "+name+"\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\n")
        run_sql(container, service, sql)
        print("Created dedicated staging database and restricted roles: "+service)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("BLOCKED: dedicated staging DB prerequisites or role setup failed; existing credentials were not overwritten",file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
