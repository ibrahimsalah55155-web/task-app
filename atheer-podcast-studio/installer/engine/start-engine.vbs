' Multimedia & AI Group - starts the processing engine with no window.
' Used when Premiere does not run the plugin's own launcher (e.g. installed without Creative Cloud).
' Run at Windows logon (shortcut made by Install.cmd) and by the panel. Safe to run many times:
' a second copy sees the running engine and exits.
Option Explicit
Dim fso, sh, d, q, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
d = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
On Error Resume Next
sh.Environment("PROCESS").Remove "PYTHONHOME"
sh.Environment("PROCESS").Remove "PYTHONPATH"
On Error GoTo 0
cmd = q & d & "\python\pythonw.exe" & q & " -m atheer_companion --port-range 47820-47823" & _
      " --token-file " & q & d & "\autostart.token" & q & _
      " --ffmpeg " & q & d & "\ffmpeg\ffmpeg.exe" & q & _
      " --ffprobe " & q & d & "\ffmpeg\ffprobe.exe" & q
sh.CurrentDirectory = d
sh.Run cmd, 0, False
