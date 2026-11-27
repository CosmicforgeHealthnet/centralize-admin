#!/usr/bin/python3 -I
"""Root-owned staging capability. Never accepts shell, paths, env overrides or uploads."""
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

BUNDLE = Path("/opt/cosmicforge/product-admin-staging/bundle")
SCRIPT = BUNDLE / "infrastructure/product-admin/release/pa-staging-ops.sh"
PREFIX = "ghcr.io/cosmicforgehealthnet/"
PROTOCOL = "cf-product-admin-staging-v1"
REPO_API = "https://api.github.com/repos/CosmicforgeHealthnet/centralize-admin"
BUNDLE_FILES = ("infrastructure/product-admin/release/pa-staging-ops.sh",
    "infrastructure/product-admin/release/pa-staging-db-bootstrap.py",
    "infrastructure/product-admin/release/pa-staging-capability.py",
    "infrastructure/product-admin/staging/network-policy.json",
    "infrastructure/product-admin/staging/docker-compose.yml",
    "infrastructure/product-admin/nginx/internal-deny.conf",
    "infrastructure/product-admin/firewall/docker-user-rules.sh",
    "infrastructure/scripts/product-admin-infra-check.mjs")

def validate(data):
    if not isinstance(data, dict):
        raise ValueError("request must be an object")
    if data == {"op": "probe"}:
        return {}
    required = {"op", "sha", "pic", "karryam", "cfmeet", "run", "user", "token"}
    if set(data) != required or data["op"] != "deploy":
        raise ValueError("unsupported operation or fields")
    if any(not isinstance(v, str) for v in data.values()):
        raise ValueError("all fields must be strings")
    def match(key, pattern):
        if not re.fullmatch(pattern, data[key]):
            raise ValueError("invalid " + key)
    match("sha", r"[a-f0-9]{40}")
    match("run", r"[0-9]{1,20}-[0-9]{1,10}")
    match("user", r"[A-Za-z0-9][A-Za-z0-9_\-\[\]]{0,99}")
    match("token", r"[A-Za-z0-9_\-]{1,4096}")
    for key, service in (("pic", "product-integration-core"), ("karryam", "karryam-admin"), ("cfmeet", "cfmeet-admin")):
        if key == "cfmeet" and not data[key]:
            continue
        match(key, re.escape(PREFIX + service + "@sha256:") + r"[a-f0-9]{64}")
    return {
        "PA_RELEASE_SHA": data["sha"], "PA_PIC_IMAGE": data["pic"],
        "PA_KA_IMAGE": data["karryam"], "PA_CM_IMAGE": data["cfmeet"],
        "PA_RUN_ID": data["run"], "GHCR_USER": data["user"], "GHCR_TOKEN": data["token"],
        "PA_CM_BRIDGE_MODE": "same-host", "PA_CM_BRIDGE_ADDRESS": "10.231.14.2",
        "PA_CM_BRIDGE_PORT": "8460",
    }

def protected(path):
    # The approved bundle is installed by root, never written by CI.
    for part in (path, *path.parents):
        st = part.lstat()
        if part.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError("root-owned capability bundle is not protected")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def api_request(path, token):
    if not path.startswith("/"):
        raise ValueError("invalid fixed API path")
    return urllib.request.Request(REPO_API+path, headers={
        "Accept":"application/vnd.github+json", "Authorization":"Bearer "+token,
        "X-GitHub-Api-Version":"2022-11-28", "User-Agent":PROTOCOL})

def api_json(path, token):
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(api_request(path, token), timeout=20) as response:
        raw = response.read(2_000_001)
        if len(raw)>2_000_000:
            raise ValueError("oversized GitHub response")
        return json.loads(raw)

def artifact_bytes(artifact_id, token):
    # Do not forward the GitHub token to the signed artifact download URL.
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(api_request("/actions/artifacts/"+str(artifact_id)+"/zip", token), timeout=20) as response:
            raw = response.read(1_000_001)
    except urllib.error.HTTPError as exc:
        if exc.code not in (301,302,303,307,308):
            raise
        url=exc.headers.get("Location","")
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("invalid artifact redirect")
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(urllib.request.Request(url,headers={"User-Agent":PROTOCOL}), timeout=30) as response:
            raw=response.read(1_000_001)
    if len(raw)>1_000_000:
        raise ValueError("oversized image evidence")
    return raw

def artifact_digests(raw, sha):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        def item(name):
            matches=[x for x in archive.infolist() if x.filename==name]
            if len(matches)!=1 or matches[0].file_size>100_000:
                raise ValueError("invalid image evidence entry")
            return archive.read(matches[0])
        report=json.loads(item("product-admin-image-digests.json"))
        if report.get("environment")!="staging" or report.get("source_sha")!=sha:
            raise ValueError("artifact revision does not match")
        result={}
        for line in item("digests.txt").decode("utf-8").splitlines():
            name, digest=line.split()
            if name in result:
                raise ValueError("duplicate digest")
            result[name]=digest
        return result

def certify(data):
    token, sha=data["token"], data["sha"]
    run, attempt=map(int,data["run"].split("-"))
    def require_head():
        if api_json("/git/ref/heads/staging",token)["object"]["sha"]!=sha:
            raise ValueError("staging revision superseded")
    require_head()
    record=api_json("/actions/runs/"+str(run),token)
    if (record.get("head_sha")!=sha or record.get("head_branch")!="staging"
        or record.get("event")!="push" or record.get("run_attempt")!=attempt
        or record.get("path")!=".github/workflows/product-admin-staging-ops.yml"):
        raise ValueError("not the exact staging-push delivery run")
    jobs=api_json("/actions/runs/"+str(run)+"/attempts/"+str(attempt)+"/jobs?per_page=100",token)["jobs"]
    for required in ("S0 - reviewed commit and required CI","Build, smoke-test and publish immutable images"):
        matches=[j for j in jobs if j.get("name")==required]
        if len(matches)!=1 or matches[0].get("conclusion")!="success":
            raise ValueError("required delivery job not successful")
    arts=api_json("/actions/runs/"+str(run)+"/artifacts?per_page=100",token)["artifacts"]
    arts=[x for x in arts if x.get("name")=="product-admin-image-digests" and not x.get("expired")]
    if len(arts)!=1:
        raise ValueError("missing or ambiguous certified image artifact")
    got=artifact_digests(artifact_bytes(arts[0]["id"],token),sha)
    expected={"product-integration-core":data["pic"],"karryam-admin":data["karryam"]}
    if data["cfmeet"]:
        expected["cfmeet-admin"]=data["cfmeet"]
    if got!=expected:
        raise ValueError("requested images differ from CI-certified digests")
    # Fixed reviewed privileged code can serve unlimited application revisions,
    # but any change to that root code requires explicit capability reinstallation.
    for rel in BUNDLE_FILES:
        file=BUNDLE/rel
        protected(file)
        content=file.read_bytes()
        oid=hashlib.sha1(("blob "+str(len(content))+"\0").encode()+content).hexdigest()
        metadata=api_json("/contents/"+rel+"?ref="+sha,token)
        if metadata.get("type")!="file" or metadata.get("sha")!=oid:
            raise ValueError("root capability bundle differs from certified revision")
    require_head()

def main():
    try:
        if os.geteuid() != 0 or len(sys.argv) != 1:
            raise ValueError("requires the installed root capability with no arguments")
        for rel in BUNDLE_FILES:
            protected(BUNDLE/rel)
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("request too large")
        data = json.loads(raw)
        env = validate(data)
        if data["op"] == "probe":
            print(PROTOCOL)
            return
        certify(data)
        # No caller-provided PATH, Docker context, PA_* overrides, shell or command.
        os.umask(0o077)
        os.chdir("/")
        os.execve("/bin/bash", ["bash", str(SCRIPT), "auto-deploy"], {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root",
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", **env
        })
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, urllib.error.URLError) as exc:
        # Never print raw request, token, or arbitrary exception text.
        print("BLOCKED: request, CI image provenance, or installed root bundle verification failed. No privileged deployment was started.", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
