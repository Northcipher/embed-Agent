!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\resources\desktop-runtime\integrations\install-windows.ps1" 0 postinstall_done
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\desktop-runtime\integrations\install-windows.ps1" -InstallDir "$INSTDIR"' $0
  IntCmp $0 0 postinstall_done
  MessageBox MB_ICONSTOP "Embed Agent post-install setup failed with exit code $0."
  Abort
postinstall_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\resources\desktop-runtime\integrations\uninstall-windows.ps1" 0 preuninstall_done
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\desktop-runtime\integrations\uninstall-windows.ps1" -InstallDir "$INSTDIR"' $0
preuninstall_done:
!macroend
