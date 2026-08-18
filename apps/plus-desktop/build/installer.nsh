; New installs default to a visible per-user folder instead of AppData;
; upgrades keep whatever directory the previous installation recorded, because
; the built-in registry lookup runs after preInit and overrides this default.
!macro preInit
  StrCpy $INSTDIR "$PROFILE\DeepSeek Harness Plus"
!macroend

; The finish page's run checkbox launches the initial-setup wizard, because the
; install writes the marker consumed at app start.
!define MUI_FINISHPAGE_RUN_TEXT "Run initial setup / 运行初始化设置"

!macro customInstall
  FileOpen $0 "$INSTDIR\run-initial-setup" w
  FileClose $0
!macroend
