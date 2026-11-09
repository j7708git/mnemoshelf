<#
Windows 正式打包音訊驗收。先完成 workspace build 與 electron-builder --win --dir。
只讀既有合成 fixture／隔離模型快取；每輪建立全新 .tmp 目錄，不修改使用者設定或套件。
不強制終止正在推論的程序；逾時回報 PID，讓維護者確認安全邊界再處理。
#>
param(
  [string]$PackageDirectory = '.tmp/audio-packaged/win-unpacked',
  [string]$ModelDirectory = '.tmp/media-feasibility/models',
  [string]$FixtureFile = '.tmp/audio-indexing-acceptance/fixtures/long.wav',
  [int]$TimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $PackageDirectory))
$modelRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $ModelDirectory))
$fixture = [IO.Path]::GetFullPath((Join-Path $repoRoot $FixtureFile))
$executable = Join-Path $packageRoot 'mnemoshelf.exe'
$asar = Join-Path (Join-Path $packageRoot 'resources') 'app.asar'
foreach ($inputPath in @($executable, $asar, $modelRoot, $fixture)) {
  if (-not (Test-Path -LiteralPath $inputPath)) { throw '缺少打包產物、隔離模型或合成長音訊，請先準備。' }
}
$runId = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$runRoot = Join-Path (Join-Path (Join-Path $repoRoot '.tmp') 'audio-packaged') $runId
$userData = Join-Path $runRoot 'user-data'
$sampleRoot = Join-Path $runRoot 'sample-root'
$reportRoot = Join-Path $runRoot 'report'
$stdout = Join-Path $runRoot 'stdout.log'
$stderr = Join-Path $runRoot 'stderr.log'
New-Item -ItemType Directory -Path $userData, $sampleRoot, $reportRoot | Out-Null
Copy-Item -LiteralPath $modelRoot -Destination (Join-Path $userData 'models') -Recurse
Copy-Item -LiteralPath $fixture -Destination (Join-Path $sampleRoot 'long.wav')
$runEnv = @{
  MNEMOSHELF_DESKTOP_USER_DATA = $userData
  MNEMOSHELF_AUTOTEST = 'audio'
  MNEMOSHELF_AUTOTEST_OUT = $reportRoot
  MNEMOSHELF_AUTOTEST_SAMPLE_ROOT = $sampleRoot
  MNEMOSHELF_AUTOTEST_QUERY = '番茄炒蛋加鹽調味'
  MNEMOSHELF_EMBED_DEVICE = 'cpu'
  MNEMOSHELF_AUTOTEST_STEP_TIMEOUT_MS = '60000'
  MNEMOSHELF_AUTOTEST_INDEX_TIMEOUT_MS = '300000'
  MNEMOSHELF_AUTOTEST_BOOTSTRAP_TIMEOUT_MS = '300000'
  ELECTRON_RUN_AS_NODE = $null
  MNEMOSHELF_AUTOTEST_SKIP_SHOTS = $null
  MNEMOSHELF_AUTOTEST_KILL_AFTER_PROGRESS = $null
}
$previous = @{}
try {
  foreach ($key in $runEnv.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    # PowerShell 7.6／新版 .NET 可能把 null 轉成空字串；Electron 看變數存在就進 Node 模式。
    if ($null -eq $runEnv[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($key, $runEnv[$key], 'Process') }
  }
  $appProcess = Start-Process -FilePath $executable -ArgumentList '--hidden' -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally {
  foreach ($key in $previous.Keys) {
    if ($null -eq $previous[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  }
}
Write-Output "音訊打包驗收已啟動：PID=$($appProcess.Id)，產物=.tmp/audio-packaged/$runId"
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while (-not $appProcess.WaitForExit(1000)) {
  if ([DateTime]::UtcNow -ge $deadline) { throw "驗收逾時，尚未強制終止 PID=$($appProcess.Id)；請檢查此輪 log。" }
}
$appProcess.WaitForExit()
$reportFile = Join-Path $reportRoot 'report.json'
if (-not (Test-Path -LiteralPath $reportFile)) { throw "程序退出 $($appProcess.ExitCode)，未產生驗收報告；請檢查此輪 log。" }
$report = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
$stepsPassed = @($report.steps | Where-Object { $_.ok -eq $true }).Count
$nativeUnpacked = @($report.environment.nativeProbe | Where-Object { $_ -match 'unpacked' }).Count
$logs = Get-Content -LiteralPath $stdout -Raw
$gracefulClose = ($logs -match '授權統計：' -and $logs -notmatch '關閉服務時發生錯誤')
$asarEntry = [string]$report.environment.appPath
$summary = [ordered]@{
  ok = ($appProcess.ExitCode -eq 0 -and $report.ok -and $report.environment.isPackaged -and $asarEntry.EndsWith('app.asar') -and $stepsPassed -eq 3 -and $nativeUnpacked -ge 4 -and $gracefulClose)
  exitCode = $appProcess.ExitCode
  gracefulClose = $gracefulClose
  isPackaged = $report.environment.isPackaged
  electron = $report.environment.electron
  node = $report.environment.node
  nativeUnpackedReports = $nativeUnpacked
  steps = $report.steps | Select-Object name, ok, detail
  screenshots = $report.screenshots.Count
  asarSha256 = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant()
  fixtureSha256 = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
  output = ".tmp/audio-packaged/$runId"
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runRoot 'summary.json') -Encoding utf8
$summary | ConvertTo-Json -Depth 6
if (-not $summary.ok) { throw '音訊打包驗收未通過，詳見此輪 report.json。' }
