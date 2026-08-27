[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$CsvPath,
    [Parameter(Mandatory = $true)]
    [string]$ParsianVersion,
    [Parameter(Mandatory = $true)]
    [string]$TestCompanyLabel,
    [ValidateSet("rial", "toman")]
    [string]$AmountUnit = "rial",
    [Parameter(Mandatory = $true)]
    [Int64]$ImportedRows,
    [Parameter(Mandatory = $true)]
    [Int64]$RejectedRows,
    [Parameter(Mandatory = $true)]
    [Int64]$ImportedDebitTotal,
    [Parameter(Mandatory = $true)]
    [Int64]$ImportedCreditTotal,
    [string]$OutputPath = ".\phase8-evidence.json"
)

$ErrorActionPreference = "Stop"

$resolvedCsv = (Resolve-Path -LiteralPath $CsvPath).Path
$rows = @(Import-Csv -LiteralPath $resolvedCsv -Encoding UTF8)
if ($rows.Count -eq 0) {
    throw "CSV حساب‌یار هیچ ردیفی ندارد."
}

$requiredHeaders = @("بدهکار تومان", "بستانکار تومان", "بدهکار ریال", "بستانکار ریال")
$headers = @($rows[0].PSObject.Properties.Name)
foreach ($header in $requiredHeaders) {
    if ($headers -notcontains $header) {
        throw "ستون الزامی '$header' در CSV پیدا نشد."
    }
}

function Sum-Column([object[]]$Items, [string]$Name) {
    [Int64]$sum = 0
    foreach ($item in $Items) {
        [Int64]$value = 0
        if (-not [Int64]::TryParse([string]$item.$Name, [ref]$value)) {
            throw "مقدار نامعتبر در ستون '$Name': $($item.$Name)"
        }
        $sum += $value
    }
    return $sum
}

$debitHeader = if ($AmountUnit -eq "rial") { "بدهکار ریال" } else { "بدهکار تومان" }
$creditHeader = if ($AmountUnit -eq "rial") { "بستانکار ریال" } else { "بستانکار تومان" }
$expectedRows = [Int64]$rows.Count
$expectedDebit = Sum-Column $rows $debitHeader
$expectedCredit = Sum-Column $rows $creditHeader

$passed = $ImportedRows -eq $expectedRows -and
          $RejectedRows -eq 0 -and
          $ImportedDebitTotal -eq $expectedDebit -and
          $ImportedCreditTotal -eq $expectedCredit -and
          $expectedDebit -eq $expectedCredit
$outcome = if ($passed) { "passed" } else { "failed" }
$errorSummary = if ($passed) { "" } else { "تعداد ردیف، ردیف ردشده یا جمع مقصد با CSV حساب‌یار برابر نیست." }

$evidence = [ordered]@{
    softwareName = "پارسیان"
    softwareVersion = $ParsianVersion.Trim()
    testCompanyLabel = $TestCompanyLabel.Trim()
    attemptType = "trial-import"
    outcome = $outcome
    amountUnit = $AmountUnit
    importedRows = $ImportedRows
    rejectedRows = $RejectedRows
    importedDebitTotal = $ImportedDebitTotal
    importedCreditTotal = $ImportedCreditTotal
    expectedRows = $expectedRows
    expectedDebitTotal = $expectedDebit
    expectedCreditTotal = $expectedCredit
    csvSha256 = (Get-FileHash -LiteralPath $resolvedCsv -Algorithm SHA256).Hash.ToLowerInvariant()
    testedAtUtc = [DateTime]::UtcNow.ToString("o")
    errorSummary = $errorSummary
    note = "نتیجه با CSV ثابت حساب‌یار و واحد مبلغ صریح کنترل شد."
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$evidence | ConvertTo-Json -Depth 4 | Out-File -LiteralPath $resolvedOutput -Encoding utf8

if ($passed) {
    Write-Host "PASS: Trial Import منطبق است. مدرک: $resolvedOutput" -ForegroundColor Green
    exit 0
}

Write-Host "FAIL: نتیجه مقصد با CSV حساب‌یار منطبق نیست. مدرک: $resolvedOutput" -ForegroundColor Red
exit 2
