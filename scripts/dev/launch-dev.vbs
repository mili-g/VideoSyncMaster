Option Explicit

Dim shell, fso, scriptDir, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = scriptDir & "\launch-dev.bat"

If fso.FileExists(launcher) Then
    shell.Run "cmd /c """ & launcher & """", 0, False
Else
    shell.Run "cmd /c echo Missing launcher: """ & launcher & """ && pause", 1, False
End If
