@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ManuFlow ERP - Tally Import

REM ===================================================================
REM  ManuFlow ERP - TallyPrime XML import
REM
REM  Usage:
REM    1. Drag a *_tally.xml file (downloaded from Sales Invoices ->
REM       Tally menu) onto this .bat file, OR
REM    2. Double-click it to pick the newest *_tally.xml in Downloads.
REM
REM  Tally must be open with its HTTP server on:
REM    F1 Help -> Settings -> Connectivity -> Client/Server configuration
REM    "TallyPrime acts as": Both, Port: 9000
REM
REM  Optional: put "TALLY_URL=http://192.168.1.20:9000" in a file called
REM  Tally-Import.config.txt next to this .bat to use another machine.
REM ===================================================================

set "TALLY=http://127.0.0.1:9000"
set "CONFIG=%~dp0Tally-Import.config.txt"
if exist "%CONFIG%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%CONFIG%") do (
    if /i "%%A"=="TALLY_URL" set "TALLY=%%B"
  )
)

set "XML=%~1"

if "%XML%"=="" (
  echo No file dropped - looking for the newest *_tally.xml in Downloads...
  for /f "delims=" %%F in ('dir /b /o-d "%USERPROFILE%\Downloads\*_tally.xml" 2^>nul') do (
    set "XML=%USERPROFILE%\Downloads\%%F"
    goto :found
  )
  echo.
  echo   No *_tally.xml found in Downloads.
  echo   Download the Tally file from ManuFlow first ^(Sales Invoices - Tally menu^),
  echo   or drag the file onto this .bat.
  echo.
  pause
  exit /b 1
)

:found

if not exist "%XML%" (
  echo   File not found: %XML%
  pause
  exit /b 1
)

echo.
echo   File  : %XML%
echo   Tally : %TALLY%
echo.

set "RESP=%TEMP%\manuflow_tally_response.xml"
if exist "%RESP%" del "%RESP%" >nul 2>&1

REM ---- POST the voucher to Tally (curl ships with Windows 10 1803+) ----
where curl >nul 2>&1
if errorlevel 1 (
  echo   curl not found - falling back to PowerShell...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $b = [IO.File]::ReadAllBytes('%XML%'); (New-Object Net.WebClient).UploadData('%TALLY%', 'POST', $b) | Set-Content -Path '%RESP%' -Encoding UTF8 } catch { Write-Host $_.Exception.Message; exit 1 }"
  set "CURLERR=%errorlevel%"
) else (
  curl -s -m 30 -X POST -H "Content-Type: application/xml" --data-binary "@%XML%" "%TALLY%" -o "%RESP%"
  set "CURLERR=%errorlevel%"
)

if not "%CURLERR%"=="0" (
  echo   [X] Could not reach Tally. ^(error %CURLERR%^)
  echo.
  echo       - Is TallyPrime open with a company loaded?
  echo       - F1 Help ^> Settings ^> Connectivity ^> Client/Server configuration
  echo         "TallyPrime acts as": Both, Port: 9000
  echo       - Different machine? Add TALLY_URL=... to Tally-Import.config.txt
  echo.
  pause
  exit /b 1
)

if not exist "%RESP%" (
  echo   [X] Tally did not answer.
  pause
  exit /b 1
)

REM ---- Read Tally's import counts ----
set "CREATED=0"
set "ALTERED=0"
set "ERRORS=0"
set "EXCEPTIONS=0"

for /f "tokens=2 delims=<> " %%A in ('findstr /c:"<CREATED>" "%RESP%"') do set "CREATED=%%A"
for /f "tokens=2 delims=<> " %%A in ('findstr /c:"<ALTERED>" "%RESP%"') do set "ALTERED=%%A"
for /f "tokens=2 delims=<> " %%A in ('findstr /c:"<ERRORS>" "%RESP%"') do set "ERRORS=%%A"
for /f "tokens=2 delims=<> " %%A in ('findstr /c:"<EXCEPTIONS>" "%RESP%"') do set "EXCEPTIONS=%%A"

echo %CREATED%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo   [X] Could not read Tally's reply. Full response:
  echo.
  type "%RESP%"
  echo.
  pause
  exit /b 1
)

echo   created=%CREATED%  altered=%ALTERED%  errors=%ERRORS%  exceptions=%EXCEPTIONS%
echo.

REM ---- Explicit rejection from Tally ----
findstr /c:"<LINEERROR>" "%RESP%" >nul 2>&1
if not errorlevel 1 (
  echo   [X] Tally rejected the voucher:
  echo.
  for /f "tokens=* delims= " %%L in ('findstr /c:"<LINEERROR>" "%RESP%"') do (
    set "LINE=%%L"
    for /f "tokens=2 delims=<>" %%A in ("!LINE!") do echo       %%A
  )
  echo.
  echo   Common causes:
  echo     - "Ledger not found"          =^> run "Tally masters (XML)" from
  echo                                      ManuFlow Settings -^> Tally export, or
  echo                                      create that ledger in Tally
  echo     - "Could not set SVCURRENTCOMPANY" =^> open the right company in Tally
  echo     - "Voucher date is missing"    =^> Tally is in a restricted date mode
  echo     - "Stock item not found"       =^> create the item (or import the
  echo                                      masters file) in Tally
  echo.
  pause
  exit /b 1
)

echo ===== TALLY FULL RESPONSE =====
type "%RESP%"
echo ===============================
echo.

if "%ERRORS%"=="0" if "%EXCEPTIONS%"=="0" (
  if not "%CREATED%"=="0" goto :success
  if not "%ALTERED%"=="0" goto :success
)

echo   [X] The voucher was neither created nor altered.
echo   Tally's full response is above.
echo.
pause
exit /b 1

:success
echo   [OK] Voucher imported into Tally.
echo.
echo   created=%CREATED%  altered=%ALTERED%
echo.
echo   Check it in: Gateway of Tally ^> Day Book ^> F2: Date ^> invoice date
echo   Re-importing the same file updates that voucher instead of duplicating it
echo   ^(each ManuFlow invoice carries its own REMOTEID^).
echo.
pause
exit /b 0
