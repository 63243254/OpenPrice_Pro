# 注册 Windows 计划任务：每天 00:00 自动更新 OpenPrice Pro 汇率与价格数据
$TaskName = "OpenPricePro-DailyMidnightUpdate"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node -ErrorAction Stop).Source
$ScriptPath = Join-Path $ProjectDir "scripts\update-prices.mjs"

$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$ScriptPath`"" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -Daily -At "00:00"
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "OpenPrice Pro 每日 00:00 自动更新全球 160+ 实时汇率与 AI 订阅价格快照" `
  -Force | Out-Null

Write-Host "已成功注册 Windows 每日 00:00 自动更新任务：$TaskName" -ForegroundColor Green
Write-Host "命令：$NodePath `"$ScriptPath`""
Write-Host "提示：即使电脑在 00:00 处于休眠/关机状态，开机后系统也会自动补跑一次更新 (StartWhenAvailable)。"
