param(
  [ValidateSet("focused", "full")]
  [string] $Mode = "full",

  [int] $Repeat = 1
)

$ErrorActionPreference = "Stop"
$env:COMPOSE_DISABLE_ENV_FILE = "true"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$composeFile = Join-Path $repoRoot "docker-compose.social-ci-parity.yml"

docker version | Out-Host
docker compose -f $composeFile up -d postgres

try {
  if ($Mode -eq "focused") {
    $focusedCommand = "npm ci && npx prisma generate --schema prisma/schema.prisma && npx prisma db push --schema prisma/schema.prisma && npm run db:admin:prepare && npm run db:schema:assert && for i in `$(seq 1 $Repeat); do echo docker-ci-focused-run=`$i status=running; npm run test:social-operations; echo docker-ci-focused-run=`$i status=passed; done"
    docker compose -f $composeFile run --rm app sh -lc $focusedCommand
    if ($LASTEXITCODE -ne 0) { throw "docker focused parity failed with exit code $LASTEXITCODE" }
  } else {
    for ($i = 1; $i -le $Repeat; $i++) {
      Write-Host "docker-ci-parity mode=$Mode run=$i status=running"
      docker compose -f $composeFile run --rm app
      if ($LASTEXITCODE -ne 0) { throw "docker full parity run $i failed with exit code $LASTEXITCODE" }
      Write-Host "docker-ci-parity mode=$Mode run=$i status=passed"
    }
  }
} finally {
  docker compose -f $composeFile down --volumes
}
