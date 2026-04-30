@echo off
color 0A
echo.
echo.
echo      8""""                                    8   8  8                                       8   8 8   8 8     
echo      8     eeeee eeeee eeeee eeee eeeee       8   8  8 e   e e  eeeee eeeee eeee eeeee        8 8   8 8  8     
echo      8eeee 8   8 8   "   8   8    8   8       8e  8  8 8   8 8  8   " 8   8 8    8   8        eee   eee  8e    
echo      88    8eee8 8eeee   8e  8eee 8eee8e eeee 88  8  8 8eee8 8e 8eeee 8eee8 8eee 8eee8e eeee 88  8 88  8 88    
echo      88    88  8    88   88  88   88   8      88  8  8 88  8 88    88 88    88   88   8      88  8 88  8 88    
echo      88    88  8 8ee88   88  88ee 88   8      88ee8ee8 88  8 88 8ee88 88    88ee 88   8      88  8 88  8 88eee 
echo.
echo.                                                                                                            

:: Enable delayed variable expansion
setlocal enabledelayedexpansion

:: Check if files were dropped onto the batch file
if "%~1"=="" (
    echo Nothing to do. Read usage instruction at this link:
    echo https://github.com/Purfview/whisper-standalone-win/discussions/337
    echo.
    pause
    color
    exit /b
)

:: Initialize file list
set "file_list="

:: Collect all file paths
for %%F in (%*) do (
    set "file_list=!file_list! "%%~F""
)


:: The command
faster-whisper-xxl.exe %file_list% -pp -o source --batch_recursive --check_files --standard -f json srt -m medium


pause
color
exit /b