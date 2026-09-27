# refresh-mobile-link.ps1 -- generate a local "open the panel" jump page for the phone.
#
# Why: opening the link inside an in-app browser (WeChat/QQ/etc.) often fails to persist
# the HttpOnly; SameSite=Strict auth cookie, so the phone keeps seeing
# "dsh web authentication required". Opening a LOCAL html file in the SYSTEM browser and
# letting it meta-refresh to the panel avoids that class of failure.
#
# The token rotates on every host restart, so re-run this after each restart and re-send
# the generated file to the phone.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File D:\cc-tasks\refresh-mobile-link.ps1
#   powershell -ExecutionPolicy Bypass -File D:\cc-tasks\refresh-mobile-link.ps1 -OutDir "$env:USERPROFILE\Desktop"
# NOTE: pure ASCII on purpose -- PS 5.1 reads script files as ANSI unless they carry a BOM,
#       so non-ASCII source would be mojibake and fail to parse.
[CmdletBinding()]
param(
  [string]$Template = 'D:\cc-tasks\mobile-open.html.tpl',
  [string]$OutDir = 'D:\cc-tasks',
  [string]$Work = 'D:\dsh relay test'
)
$ErrorActionPreference = 'Stop'

# 1) read the current link (current-link.mjs proves it: right token -> 303, wrong -> 401)
$raw = & node (Join-Path $Work 'current-link.mjs') 2>&1 | Out-String
$m = [regex]::Match($raw, 'https://[^\s]*\?token=[A-Za-z0-9_-]+')
if (-not $m.Success) {
  Write-Error ("could not parse a link from current-link.mjs output:" + [Environment]::NewLine + $raw)
  exit 1
}
$url = $m.Value

# 2) render the template
if (-not (Test-Path $Template)) { Write-Error ("template missing: " + $Template); exit 1 }
$html = Get-Content $Template -Raw -Encoding UTF8
$html = $html.Replace('__TARGET__', $url)

# 3) write output (ASCII filename so it is easy to find on the phone)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$out = Join-Path $OutDir 'mobile-open.html'
[IO.File]::WriteAllText($out, $html, (New-Object Text.UTF8Encoding($true)))

Write-Host ("[mobile] generated : " + $out)
Write-Host ("[mobile] target    : " + $url.Substring(0, [Math]::Min(70, $url.Length)) + "...")
Write-Host "[mobile] next      : send this html to the phone, then open it from the FILE MANAGER"
Write-Host "[mobile]             (system browser, NOT an in-app webview)."
Write-Host "[mobile] note      : token rotates on every host restart -- re-run this script after a restart."
