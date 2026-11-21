#!/usr/bin/env python3
"""Read-only Karryam deployment inventory. Run on the authorized staging host.

Uses Docker inspect and SELECT-only transactions in the two integration services.
Never prints environment values, credentials, source business rows or policy keys.
Does not restart services, change flags, enroll principals or grant staff access.
"""
import datetime
import json
import subprocess
from pathlib import Path

SERVICES = [
    ("Analytics Service", "analytics-service", ["karrygo-analytics-service"]),
    ("Support/Dispute Service", "support-dispute-service", ["karrygo-support-dispute-service"]),
    ("Payment/Wallet Service", "payment-wallet-service", ["karrygo-payment-wallet-service"]),
    ("Verification/Compliance Service", "verification-compliance-service", ["karrygo-verification-staging"]),
    ("Notification Service", "notification-service", ["karrygo-notification-service"]),
    ("Taxi Service", "driver-taxi-service", ["karrygo-taxi-service"]),
    ("Customer Service", "customer-service", ["karrygo-customer-service"]),
    ("Dispatch/Delivery Service", "driver-dispatch-delivery-service", ["karrygo-dispatch-delivery-service"]),
    ("Hauling Service", "driver-hauling-service", ["karrygo-hauling-service"]),
    ("Fleet Partner Service", "fleet-partner-service", ["karrygo-fleet-partner-api"]),
    ("Media/File Service", "media-file-service", ["karrygo-media-file-service"]),
    ("Pricing Service", "pricing-service", ["karrygo-pricing-service"]),
    ("Vendor Service", "vendor-service", ["karrygo-vendor-api-staging"]),
    ("Referral Service", "referral-service", ["karrygo-referral-service"]),
]

def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=25)

def inspect(name):
    result = command(["docker", "inspect", name])
    return json.loads(result.stdout)[0] if result.returncode == 0 else None

def environment(item):
    return dict(value.split("=", 1) for value in item["Config"]["Env"] if "=" in value)

def public_metadata(item):
    env = environment(item)
    return {
        "container": item["Name"].lstrip("/"),
        "status": item["State"]["Status"],
        "docker_health": item["State"].get("Health", {}).get("Status"),
        "image": item["Config"]["Image"], "image_id": item["Image"],
        "configured_admin_flags": {key: value.lower() in ("true", "1") for key, value in env.items()
            if "ADMIN" in key and key.endswith("_ENABLED") and value.lower() in ("true", "false", "0", "1")},
        "credential_or_policy_files_configured": sorted(key for key, value in env.items()
            if value and "ADMIN" in key and key.endswith(("_SECRET_FILE", "_POLICY_FILE", "_POLICY_KEYS_FILE"))),
    }

def signed_policy_summary(bridge):
    path = environment(bridge).get("ADMIN_ACCESS_POLICY_FILE")
    if not path:
        return {"configured": False}
    for mount in sorted(bridge["Mounts"], key=lambda item: len(item["Destination"]), reverse=True):
        destination = mount["Destination"].rstrip("/")
        if path == destination or path.startswith(destination + "/"):
            host = Path(mount["Source"]) / path[len(destination):].lstrip("/")
            document = json.loads(host.read_text())["document"]
            return {"configured": True, "version": document.get("version"), "expires_at": document.get("expires_at"),
                "rules": [{key: rule[key] for key in ("capability", "owner", "source_contract", "roles", "purposes") if key in rule}
                    for rule in document.get("rules", [])]}
    return {"configured": True, "readable_from_inspected_mount": False}

def database_checks(container, env_name, queries):
    # This code runs inside the service, using only its own existing runtime DB role.
    script = """const {Pool}=require('pg');const p=new Pool({connectionString:process.env[ENV_NAME],connectionTimeoutMillis:3000,statement_timeout:5000});
(async()=>{await p.query('BEGIN READ ONLY');for(const [check,sql] of QUERIES){const r=await p.query(sql);console.log(JSON.stringify({check,rows:r.rows}));}await p.query('ROLLBACK');})()
.catch(e=>{console.log(JSON.stringify({check_failed:true,code:e.code||'QUERY_FAILED'}));process.exitCode=1;}).finally(()=>p.end());"""
    script = script.replace("ENV_NAME", json.dumps(env_name)).replace("QUERIES", json.dumps(queries))
    result = command(["docker", "exec", container, "node", "-e", script])
    rows = []
    for line in result.stdout.splitlines():
        if line.startswith("{"):
            rows.append(json.loads(line))
    return {"succeeded": result.returncode == 0, "checks": rows}

def main():
    output = {"checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "read_only": True, "source_services": [], "caveat": "Running containers and static flags do not prove an authorized live source read."}
    for title, owner, names in SERVICES:
        found = next((item for name in names if (item := inspect(name))), None)
        output["source_services"].append({"service": title, "owner": owner,
            "runtime": public_metadata(found) if found else None,
            "not_found_meaning": None if found else "No container matched the known names; this is not proof the service is absent elsewhere."})
    bridge = inspect("karrygo-admin-backoffice-service")
    output["bridge"] = public_metadata(bridge) if bridge else None
    output["signed_policy"] = signed_policy_summary(bridge) if bridge else {"configured": False}
    output["hq"] = database_checks("cf-product-admin-staging-product-integration-core-1", "PIC_DATABASE_URL", [
        ("products", "SELECT product_id,lifecycle_status,health_status,sync_status,drift_status FROM hq_integration.hq_product_admins"),
        ("subscriptions", "SELECT consumer_department,status,enabled,coverage,last_success_at,last_source_observation_at FROM hq_integration.hq_product_admin_subscriptions"),
        ("metric_observations", "SELECT metric_id,value_state,coverage,source_observed_at FROM hq_integration.hq_product_admin_metrics ORDER BY metric_id,source_observed_at DESC")])
    output["karryam_admin"] = database_checks("cf-product-admin-staging-karryam-admin-1", "KARRYAM_ADMIN_DATABASE_URL", [
        ("feed_partitions", "SELECT partition_key,last_sequence,acked_sequence,last_error_code FROM karryam_admin.bridge_feed_partitions"),
        ("source_coverage", "SELECT source_service,entity_type,bridge_coverage,bridge_open_gaps,bridge_freshness,bridge_backfill,observed_at FROM karryam_admin.source_coverage")])
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
