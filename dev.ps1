# GNOSIA — run the backend (Node.js :8000) and the frontend (Vite :5173) together for development.
#   .\dev.ps1            start both (Ctrl+C stops both)
#   .\dev.ps1 -Setup     first run: install packages and seed the demo data
#   .\dev.ps1 -Reseed    wipe the database and seed the demo data again
# Without GNOSIA_DATABASE_URL (see backend-node\.env.example) the backend uses an embedded PostgreSQL stored in backend-node\data.
param([switch]$Setup, [switch]$Reseed)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend-node'
$frontend = Join-Path $root 'frontend'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

if ($Setup) {
  Push-Location $backend; npm install --no-audit --no-fund; npm run seed; Pop-Location
  Push-Location $frontend; npm install --no-audit --no-fund; Pop-Location
}
if ($Reseed) { Push-Location $backend; npm run seed -- --reset; Pop-Location }

$api = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev') -WorkingDirectory $backend -PassThru -NoNewWindow
try {
  Push-Location $frontend
  npx vite --port 5173
} finally {
  Pop-Location
  # npm starts node as a child process: /T also stops the children
  if ($api -and -not $api.HasExited) { taskkill /PID $api.Id /T /F | Out-Null }
}
