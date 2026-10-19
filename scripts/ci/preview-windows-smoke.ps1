# Preview-only native qualification. Release signing and signature assertions
# remain in desktop-build.yml. Keep the install/protocol/updater/uninstall checks.
$ErrorActionPreference = "Stop"
if ($env:DESKTOP_SOURCE_SHA -cnotmatch '^[a-f0-9]{40}$' -or
    $env:PREVIEW_ARTIFACT_PREFIX -cnotmatch "^preview-desktop-pr[1-9][0-9]*-$($env:DESKTOP_SOURCE_SHA)-lease[1-9][0-9]*$") {
  throw "Invalid source-bound Windows preview metadata"
}
$env:PACKAGE_VERSION = node -p "require('./desktop/package.json').version"
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve Windows preview version" }
$env:ARTIFACT_BASE = "Matrix-OS-$($env:PACKAGE_VERSION)-win-x64"
$env:CHANNEL = "dev"

$ErrorActionPreference = "Stop"
$installerPath = Join-Path $PWD "desktop/dist/$env:ARTIFACT_BASE.exe"
$blockmapPath = "$installerPath.blockmap"
$manifestPath = Join-Path $PWD "desktop/dist/latest.yml"
$appPath = Join-Path $PWD "desktop/dist/win-unpacked/Matrix OS.exe"
$appUpdatePath = Join-Path $PWD "desktop/dist/win-unpacked/resources/app-update.yml"
foreach ($path in @($installerPath, $blockmapPath, $manifestPath, $appPath, $appUpdatePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing expected Windows preview artifact: $path"
  }
}
$unexpected = Get-ChildItem desktop/dist -File -Filter "Matrix-OS-*-win-*.exe" |
  Where-Object { $_.FullName -ne $installerPath }
if ($unexpected) {
  throw "Windows build produced unexpected installer: $($unexpected[0].Name)"
}
foreach ($unsignedPath in @($appPath, $installerPath)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $unsignedPath
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
    throw "Windows preview must be unsigned: $unsignedPath (status: $($signature.Status))"
  }
}
$asarEntries = pnpm exec asar list "desktop/dist/win-unpacked/resources/app.asar"
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect packaged Windows app" }
if ($asarEntries -match "node_modules/@matrix-os/contracts") {
  throw "Packaged app contains raw @matrix-os/contracts sources"
}

Copy-Item desktop/dist/latest.yml desktop/dist/dev.yml

$ErrorActionPreference = "Stop"
$installerPath = Join-Path $PWD "desktop/dist/$env:ARTIFACT_BASE.exe"
$installedAppPath = $null
$uninstallerPath = $null
$smokeDirectory = Join-Path $env:RUNNER_TEMP "matrix-os-windows-smoke"
New-Item -ItemType Directory -Force -Path $smokeDirectory | Out-Null
$serverProcess = $null
$appProcess = $null
try {
  Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait
  $uninstallRoot = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall"
  $uninstallEntry = Get-ChildItem -LiteralPath $uninstallRoot |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
    Where-Object {
      $_.DisplayName -eq "Matrix OS" -and
      $_.DisplayVersion -eq $env:PACKAGE_VERSION
    } |
    Select-Object -First 1
  if (-not $uninstallEntry) {
    throw "Silent NSIS install did not register Matrix OS $env:PACKAGE_VERSION"
  }
  $uninstallCommand = $uninstallEntry.QuietUninstallString
  if ($uninstallCommand -notmatch '^"([^"]+)"') {
    throw "NSIS install registered an invalid quiet uninstall command"
  }
  $uninstallerPath = $Matches[1]
  $installDirectory = Split-Path -Parent $uninstallerPath
  $installedAppPath = Join-Path $installDirectory "Matrix OS.exe"
  foreach ($path in @($installedAppPath, $uninstallerPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Silent NSIS install did not create $path"
    }
  }
  $portFile = Join-Path $smokeDirectory "update-fixture.port"
  $serverLog = Join-Path $smokeDirectory "update-fixture.log"
  $serverErrorLog = Join-Path $smokeDirectory "update-fixture-error.log"
  $serverProcess = Start-Process -FilePath "node" -ArgumentList @(
    "scripts/release/desktop-update-fixture-server.mjs",
    "--platform", "windows",
    "--channel", $env:CHANNEL,
    "--version", $env:PACKAGE_VERSION,
    "--port-file", $portFile
  ) -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog
  for ($attempt = 1; $attempt -le 40 -and -not (Test-Path $portFile); $attempt++) {
    if ($serverProcess.HasExited) {
      throw "Desktop update fixture server exited before becoming ready"
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path $portFile)) {
    throw "Desktop update fixture server did not become ready"
  }
  $updatePort = (Get-Content -Raw $portFile).Trim()
  if ($updatePort -notmatch "^[0-9]+$") {
    throw "Desktop update fixture server returned an invalid port"
  }

  $env:OPERATOR_USER_DATA_DIR = Join-Path $smokeDirectory "user-data"
  $env:OPERATOR_UPDATE_CHANNEL = $env:CHANNEL
  $env:OPERATOR_UPDATE_FEED = "http://127.0.0.1:$updatePort/"
  $appLog = Join-Path $smokeDirectory "matrix-os-launch.log"
  $appErrorLog = Join-Path $smokeDirectory "matrix-os-launch-error.log"
  $appProcess = Start-Process -FilePath $installedAppPath -ArgumentList "--disable-gpu" `
    -PassThru -RedirectStandardOutput $appLog -RedirectStandardError $appErrorLog
  foreach ($scheme in @("matrixos", "matrix-os")) {
    $protocolKey = "Registry::HKEY_CURRENT_USER\Software\Classes\$scheme"
    for ($attempt = 1; $attempt -le 40 -and -not (Test-Path -LiteralPath $protocolKey); $attempt++) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $protocolKey)) {
      throw "Installed Matrix OS did not register protocol $scheme on first launch"
    }
  }
  $updateSucceeded = $false
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    if ($appProcess.HasExited) {
      throw "Installed Windows app exited during launch smoke test"
    }
    $combinedLog = ((Get-Content $appLog, $appErrorLog -Raw -ErrorAction SilentlyContinue) -join "`n")
    if ($combinedLog.Contains("[updates] check failed:")) {
      throw "Installed Windows updater failed its fixture feed check"
    }
    if ($combinedLog.Contains("[updates] update check completed: up to date")) {
      $updateSucceeded = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $updateSucceeded) {
    throw "Installed Windows updater did not complete its fixture feed check"
  }
  if ($combinedLog.Contains("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")) {
    throw "Installed Windows app attempted to load raw TypeScript"
  }
} finally {
  if ($appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
    $appProcess.WaitForExit()
  }
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    $serverProcess.WaitForExit()
  }
  if ($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait
  }
}
if ($installedAppPath -and (Test-Path -LiteralPath $installedAppPath)) {
  throw "Silent NSIS uninstall left the installed app behind"
}

# The download contains provenance but no release updater manifest: this is an
# unsigned PR installer, never a release publication or unsigned update feed.
@{
  schema = "matrix-windows-preview-v1"
  sourceSha = $env:DESKTOP_SOURCE_SHA
  controllerSha = $env:PREVIEW_CONTROLLER_SHA
  artifactPrefix = $env:PREVIEW_ARTIFACT_PREFIX
  runId = $env:GITHUB_RUN_ID
  runAttempt = $env:GITHUB_RUN_ATTEMPT
  signed = $false
} | ConvertTo-Json | Set-Content -LiteralPath desktop/dist/windows-preview-source.json
