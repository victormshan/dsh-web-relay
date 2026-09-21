# 部署 dsh-web-relay v1.2.0 到 profile（升级部署：源 1.2.0 != 安装 1.1.0，deploy.ps1 断言会中止，故手动复制）
# 用法: powershell -ExecutionPolicy Bypass -File deploy-v102.ps1
$ErrorActionPreference = 'Stop'
$RepoRoot = 'D:\DSH\dsh-web-relay'
$InstallDir = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-web-relay"

$srcVersion = (Get-Content "$RepoRoot\package.json" -Raw | ConvertFrom-Json).version
$instVersion = (Get-Content "$InstallDir\package.json" -Raw | ConvertFrom-Json).version
Write-Host "源仓库版本: $srcVersion  安装目录版本: $instVersion"
if ($srcVersion -ne '1.2.0') { throw "源版本不是 1.2.0，部署中止: $srcVersion" }

# 备份当前安装
$backup = "$InstallDir.bak-v102"
if (Test-Path $backup) { Write-Host "已存在备份 $backup，跳过备份" }
else {
  Copy-Item $InstallDir $backup -Recurse -Force
  Write-Host "已备份当前安装到: $backup"
}

# 复制 4 个部署文件
foreach ($f in @('lib\index.js', 'lib\client.js', 'package.json', 'cordis.patch.yml')) {
  Copy-Item "$RepoRoot\$f" "$InstallDir\$f" -Force
  Write-Host "  已部署: $f"
}

$nowVersion = (Get-Content "$InstallDir\package.json" -Raw | ConvertFrom-Json).version
Write-Host "部署完成（安装目录版本 $nowVersion）。Host 半改动需重启 dsh web；client 半 HMR 自动生效。"
