# Installs Voice Coding Companion from a source checkout on Windows.
# Usage (from the repository folder):  powershell -ExecutionPolicy Bypass -File install.ps1 [-Models] [-NoModels]
param([switch]$Models, [switch]$NoModels)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Fail($msg) { Write-Host "x $msg" -ForegroundColor Red; exit 1 }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed. Install Node.js 20+ from https://nodejs.org and run this again.' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Fail "Node.js $(node --version) is too old. Install Node.js 20 or newer." }
Write-Host "Node.js $(node --version) found."

Write-Host 'Installing dependencies (npm ci)...'
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed. See the output above.' }

Write-Host 'Building...'
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'Build failed. See the output above.' }

if (-not $NoModels) {
  $get = $Models
  if (-not $get) {
    $answer = Read-Host 'Download on-device speech recognition (~65 MB from huggingface.co) so speech works offline? [Y/n]'
    $get = ($answer -eq '' -or $answer -match '^[Yy]')
  }
  if ($get) { npm run models -- moonshine-base }
  else { Write-Host 'Skipped. You can download models later from the setup wizard or with: npm run models' }
}

npm run doctor
Write-Host ''
Write-Host 'Start the app with: npm start' -ForegroundColor Green
