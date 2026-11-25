# 卸载 Windows 每日 00:00 自动更新计划任务
$TaskName = "OpenPricePro-DailyMidnightUpdate"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "已移除计划任务：$TaskName" -ForegroundColor Yellow
