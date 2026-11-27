Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
  Where-Object { $_.CommandLine -like '*tmp-chrome-browser-bridge-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-Item D:\project\projects\tmp-dataops-browser-bridge.zip -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-dataops-browser-bridge -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-chrome-browser-bridge-profile -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-chrome-browser-bridge-profile-2 -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-playwright-browser-bridge-profile -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item D:\project\projects\tmp-chrome-browser-bridge-profile-log -Recurse -Force -ErrorAction SilentlyContinue
