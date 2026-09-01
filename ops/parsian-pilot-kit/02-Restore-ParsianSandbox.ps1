[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$BackupPath,

    [string]$ServerInstance = ".\SQLEXPRESS",
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{2,80}$')]
    [string]$DatabaseName = "ParsianPilot_Sample",
    [Parameter(Mandatory = $true)]
    [string]$LogicalDataName,
    [Parameter(Mandatory = $true)]
    [string]$LogicalLogName,
    [string]$DataDirectory = "C:\ParsianPilot\SqlData",
    [Parameter(Mandatory = $true)]
    [switch]$IUnderstandThisCreatesDatabase
)

$ErrorActionPreference = "Stop"

function Escape-SqlLiteral([string]$Value) {
    return $Value.Replace("'", "''")
}

if (-not $IUnderstandThisCreatesDatabase) {
    throw "برای اجرای آگاهانه، پارامتر -IUnderstandThisCreatesDatabase الزامی است."
}
if (-not (Get-Command sqlcmd -ErrorAction SilentlyContinue)) {
    throw "ابزار sqlcmd پیدا نشد."
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
$resolvedDataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Path $resolvedDataDirectory -Force | Out-Null

$databaseLiteral = Escape-SqlLiteral $DatabaseName
$existence = & sqlcmd -S $ServerInstance -E -h -1 -W -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM master.dbo.sysdatabases WHERE name=N'$databaseLiteral';"
if ($LASTEXITCODE -ne 0) {
    throw "اتصال به SQL Server ناموفق بود."
}
if ((($existence -join "").Trim()) -ne "0") {
    throw "دیتابیس $DatabaseName از قبل وجود دارد؛ اسکریپت برای جلوگیری از بازنویسی متوقف شد. نام تازه انتخاب کن."
}

$backupLiteral = Escape-SqlLiteral $resolvedBackup
$logicalDataLiteral = Escape-SqlLiteral $LogicalDataName
$logicalLogLiteral = Escape-SqlLiteral $LogicalLogName
$dataFileLiteral = Escape-SqlLiteral (Join-Path $resolvedDataDirectory ($DatabaseName + ".mdf"))
$logFileLiteral = Escape-SqlLiteral (Join-Path $resolvedDataDirectory ($DatabaseName + "_log.ldf"))

$restoreSql = @"
RESTORE DATABASE [$DatabaseName]
FROM DISK = N'$backupLiteral'
WITH MOVE N'$logicalDataLiteral' TO N'$dataFileLiteral',
     MOVE N'$logicalLogLiteral' TO N'$logFileLiteral',
     RECOVERY, STATS = 5;
"@

& sqlcmd -S $ServerInstance -E -b -r 1 -Q $restoreSql
if ($LASTEXITCODE -ne 0) {
    throw "Restore ناموفق بود. هیچ مجوز بازنویسی اجرا نشده است. خطای SQL Server را بررسی کن."
}

Write-Host "Restore ایزوله با نام $DatabaseName کامل شد."
