[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$BackupPath,

    [string]$ServerInstance = ".\SQLEXPRESS",
    [string]$OutputDirectory = ".\evidence"
)

$ErrorActionPreference = "Stop"

function Escape-SqlLiteral([string]$Value) {
    return $Value.Replace("'", "''")
}

if (-not (Get-Command sqlcmd -ErrorAction SilentlyContinue)) {
    throw "ابزار sqlcmd پیدا نشد. SQL Server Command Line Utilities را نصب کن."
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$hash = Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256
$fileInfo = Get-Item -LiteralPath $resolvedBackup
$manifest = [ordered]@{
    backupFileName = $fileInfo.Name
    sizeBytes = $fileInfo.Length
    sha256 = $hash.Hash.ToLowerInvariant()
    inspectedAtUtc = [DateTime]::UtcNow.ToString("o")
    serverInstance = $ServerInstance
}
$manifest | ConvertTo-Json | Out-File -LiteralPath (Join-Path $resolvedOutput "backup-manifest.json") -Encoding utf8

$sqlPath = Escape-SqlLiteral $resolvedBackup
$checks = @(
    @{ Name = "verifyonly"; Query = "RESTORE VERIFYONLY FROM DISK = N'$sqlPath';" },
    @{ Name = "headeronly"; Query = "RESTORE HEADERONLY FROM DISK = N'$sqlPath';" },
    @{ Name = "filelistonly"; Query = "RESTORE FILELISTONLY FROM DISK = N'$sqlPath';" }
)

foreach ($check in $checks) {
    $outputPath = Join-Path $resolvedOutput ($check.Name + ".txt")
    & sqlcmd -S $ServerInstance -E -b -r 1 -W -s "|" -Q $check.Query -o $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "بررسی $($check.Name) ناموفق بود. فایل $outputPath را ببین و ادامه نده."
    }
}

Write-Host "بررسی بکاپ موفق بود. خروجی‌ها: $resolvedOutput"

