GTAMP RECOVERY — why story mode / no F9 / no log
================================================

WHAT WENT WRONG
- No %TEMP%\gtamp_hook.log means the DLL never loaded into GTA.
- F9 gone = hook not running. Story mode = no injection.
- Common cause: files copied to the WRONG folder, or only part
  of the update applied, so the launcher never finds:
    resources\native\gtamp_hook.dll
    resources\native\gtamp_injector.exe

WHERE LOGS ACTUALLY ARE
1) %TEMP%\gtamp_status.txt     ← launcher writes this on Connect
2) %TEMP%\gtamp_injector.log   ← injector writes this
3) %TEMP%\gtamp_hook.log       ← ONLY after successful inject
4) Next to injector:
   <launcher>\resources\native\gtamp_injector.log

HOW TO FIX (run FIX-INJECT.bat as Administrator recommended)
