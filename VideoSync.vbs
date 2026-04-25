Option Explicit

Dim shell, fso, scriptDir, appExe, devCmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appExe = scriptDir & "\ui\release\win-unpacked\VideoSync.exe"

If fso.FileExists(appExe) Then
    shell.Run Chr(34) & appExe & Chr(34), 0, False
Else
    devCmd = "cmd /c cd /d " & Chr(34) & scriptDir & "\ui" & Chr(34) & " && npm run dev"
    shell.Run devCmd, 0, False
End If
