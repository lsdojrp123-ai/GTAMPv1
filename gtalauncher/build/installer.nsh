; GTAMP v2.1.0 — setup kills any stuck/old GTAMP before installing (replaces the kill-file era)
!macro preInit
  ; old versioned portable exes (zombie windows holding the single-instance lock)
  nsExec::ExecToStack 'taskkill /F /IM "GTAMP-Launcher-*.exe" /T'
  Pop $0
  Pop $1
  ; a currently running installed copy (we are about to overwrite it)
  nsExec::ExecToStack 'taskkill /F /IM "GTAMP Launcher.exe" /T'
  Pop $0
  Pop $1
  ; leftover injector workers
  nsExec::ExecToStack 'taskkill /F /IM gtamp_injector.exe'
  Pop $0
  Pop $1
!macroend
