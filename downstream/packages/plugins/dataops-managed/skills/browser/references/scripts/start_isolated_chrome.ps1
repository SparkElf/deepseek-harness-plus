$chrome = 'C:\Users\Administrator\AppData\Local\Google\Chrome\Bin\chrome.exe'
$profile = 'D:\project\projects\tmp-chrome-browser-bridge-profile'
$extension = 'D:\project\projects\tmp-dataops-browser-bridge\extension'

if (-not (Test-Path $chrome)) {
  throw "Chrome executable not found at $chrome"
}
if (-not (Test-Path $extension)) {
  throw "Unpacked extension directory not found at $extension"
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  '--disable-background-networking',
  '--remote-debugging-port=9999',
  "--disable-extensions-except=$extension",
  "--load-extension=$extension",
  '--no-first-run',
  '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--new-window',
  'https://127.0.0.1:3000'
)
