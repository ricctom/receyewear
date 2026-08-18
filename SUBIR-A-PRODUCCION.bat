@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo    SUBIR REC EYEWEAR A PRODUCCION
echo ============================================
echo.
echo Vercel esta conectado al repo de GitHub: con mandar el
echo codigo alla, el deploy arranca solo. No hay que tocar nada mas.
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo ERROR: esta carpeta no es un repositorio git.
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------------------
REM Paso 1: si quedaron cambios sin guardar, se commitean antes de subir.
REM Miramos el tamano del volcado de "git status" en vez de usar "find": si Git
REM Bash esta en el PATH, se agarra el find de Unix y el script se rompe.
REM ---------------------------------------------------------------------------
set "ESTADO=%TEMP%\receyewear_git_estado.txt"
git status --porcelain > "%ESTADO%" 2>nul
set TAMANO=0
for %%A in ("%ESTADO%") do set TAMANO=%%~zA
del "%ESTADO%" >nul 2>&1

if "%TAMANO%"=="0" (
  echo Paso 1 de 2: no hay cambios sin guardar. Sigo.
  goto PUSH
)

echo Paso 1 de 2: hay cambios sin guardar. Estos:
echo.
git status --short
echo.
set "MSG="
set /p MSG=Escribi en una linea que cambiaste (Enter = fecha y hora): 
if not defined MSG set "MSG=Cambios del %DATE% %TIME:~0,5%"
git add -A
git commit -m "%MSG%"
if errorlevel 1 (
  echo.
  echo NO SE PUDO GUARDAR EN GIT. No subo nada hasta que esto se resuelva.
  echo.
  pause
  exit /b 1
)
echo Guardado en git.

:PUSH
echo.
echo Paso 2 de 2: mandando el codigo a GitHub...
echo.
git push
if errorlevel 1 (
  echo.
  echo ============================================
  echo  FALLO EL PUSH. No se subio nada.
  echo  Fijate el error de arriba y avisame.
  echo ============================================
  echo.
  pause
  exit /b 1
)

set "VERSION="
for /f %%h in ('git rev-parse --short HEAD 2^>nul') do set VERSION=%%h
echo.
echo ============================================
if defined VERSION echo  LISTO. Version subida: %VERSION%
if not defined VERSION echo  LISTO.
echo.
echo  Vercel esta compilando ahora. En 1 o 2 minutos
echo  entra a visionline.com.ar/admin.html y refresca
echo  con Ctrl+F5 para ver los botones nuevos.
echo ============================================
echo.
pause
