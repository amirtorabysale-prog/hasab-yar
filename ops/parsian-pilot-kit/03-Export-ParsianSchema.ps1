[CmdletBinding()]
param(
    [string]$ServerInstance = ".\SQLEXPRESS",
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{2,80}$')]
    [string]$DatabaseName = "ParsianPilot_1402",
    [string]$OutputDirectory = ".\evidence\schema"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command sqlcmd -ErrorAction SilentlyContinue)) {
    throw "ابزار sqlcmd پیدا نشد."
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$queries = @(
    @{
        Name = "tables"
        Query = "SET NOCOUNT ON; SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM [$DatabaseName].INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA,TABLE_NAME;"
    },
    @{
        Name = "columns"
        Query = "SET NOCOUNT ON; SELECT TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION,COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,NUMERIC_PRECISION,NUMERIC_SCALE,IS_NULLABLE FROM [$DatabaseName].INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION;"
    },
    @{
        Name = "keys"
        Query = "SET NOCOUNT ON; SELECT TC.TABLE_SCHEMA,TC.TABLE_NAME,TC.CONSTRAINT_NAME,TC.CONSTRAINT_TYPE,KCU.COLUMN_NAME,KCU.ORDINAL_POSITION FROM [$DatabaseName].INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC LEFT JOIN [$DatabaseName].INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU ON TC.CONSTRAINT_CATALOG=KCU.CONSTRAINT_CATALOG AND TC.CONSTRAINT_SCHEMA=KCU.CONSTRAINT_SCHEMA AND TC.CONSTRAINT_NAME=KCU.CONSTRAINT_NAME ORDER BY TC.TABLE_SCHEMA,TC.TABLE_NAME,TC.CONSTRAINT_NAME,KCU.ORDINAL_POSITION;"
    }
)

foreach ($item in $queries) {
    $outputPath = Join-Path $resolvedOutput ($item.Name + ".txt")
    & sqlcmd -S $ServerInstance -E -b -r 1 -W -s "|" -Q $item.Query -o $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "استخراج $($item.Name) ناموفق بود."
    }
}

Write-Host "Schema بدون دادهٔ مالی در $resolvedOutput ذخیره شد."

