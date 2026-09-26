# Install / uninstall Aurora Lyrics for Spicetify (Windows PowerShell).
#   .\install.ps1              build (if Node is available), copy, enable, apply
#   .\install.ps1 -NoApply     same, but don't run `spicetify apply` (Spotify won't restart)
#   .\install.ps1 -Uninstall   disable, remove the file, apply
param(
	[switch]$Uninstall,
	[switch]$NoApply
)

$ErrorActionPreference = "Stop"
$name = "aurora-lyrics.js"
$legacy = "fullscreen-animated-lyrics.js" # name before the rename; removed on install

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
	throw "spicetify was not found on PATH. Install it first: https://spicetify.app/docs/getting-started"
}

# Spicetify's user data dir (e.g. %APPDATA%\spicetify); extensions live in its Extensions folder.
$userData = (spicetify path userdata).Trim()
$extDir = Join-Path $userData "Extensions"
$target = Join-Path $extDir $name

if ($Uninstall) {
	spicetify config extensions "$name-"
	if (Test-Path $target) { Remove-Item $target -Confirm:$false }
	if (-not $NoApply) { spicetify apply }
	Write-Host "Uninstalled $name"
	return
}

$dist = Join-Path $PSScriptRoot "dist\$name"
if (Get-Command node -ErrorAction SilentlyContinue) {
	node (Join-Path $PSScriptRoot "build.mjs")
	if ($LASTEXITCODE -ne 0) { throw "Build failed" }
}
if (-not (Test-Path $dist)) { throw "Missing $dist - run 'node build.mjs' first." }

# Remove the pre-rename build so it isn't loaded twice.
if ((spicetify config extensions) -join " " -match [regex]::Escape($legacy)) { spicetify config extensions "$legacy-" }
$legacyPath = Join-Path $extDir $legacy
if (Test-Path $legacyPath) { Remove-Item $legacyPath -Confirm:$false }

New-Item -ItemType Directory -Force $extDir | Out-Null
Copy-Item $dist $target -Force
Write-Host "Copied to $target"

# Add to the enabled list only if it's not there yet (config appends duplicates otherwise).
$current = (spicetify config extensions) -join " "
if ($current -notmatch [regex]::Escape($name)) {
	spicetify config extensions $name
}

if (-not $NoApply) { spicetify apply }
Write-Host "Done. Open Spotify and press Alt+L, or click the lyrics button in the top bar."
