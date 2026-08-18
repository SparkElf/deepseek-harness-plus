; New installs default to a visible per-user folder instead of AppData;
; upgrades keep whatever directory the previous installation recorded, because
; the built-in registry lookup runs after preInit and overrides this default.
!macro preInit
  StrCpy $INSTDIR "$PROFILE\DeepSeek Harness Plus"
!macroend
