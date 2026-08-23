@echo off
setlocal
rem ============================================================
rem  link-host-deps.cmd  -  make bare '@deepseek-ai/*' imports
rem  resolvable for `link:`-installed copies of this plugin.
rem
rem  Node resolves a pnpm `link:` junction back to this real
rem  directory before resolving its imports, so the host
rem  packages imported by lib/index.js must be reachable from
rem  HERE. This script junctions them in from a dsh runtime:
rem
rem     node_modules\@deepseek-ai\dsh-web
rem     node_modules\@deepseek-ai\dsh-settings
rem     node_modules\@deepseek-ai\schemastery
rem
rem  Usage:
rem    link-host-deps.cmd [runtime-node_modules-dir]
rem
rem  Without an argument, the DshTray self-contained runtime is
rem  used. For a system-wide dsh installed via `npm i -g`, pass
rem  its nested runtime dir, e.g.:
rem    link-host-deps.cmd "C:\...\node_modules\@deepseek-ai\dsh\node_modules"
rem
rem  Re-run this after moving/reinstalling the runtime folder
rem  (junctions point at absolute paths).
rem ============================================================

set "HOST_NM=%~1"
if "%HOST_NM%"=="" set "HOST_NM=M:\1Tools\DshTray\res\dsh\dsh\node_modules"

if not exist "%HOST_NM%\@deepseek-ai\dsh-web" (
  echo [error] host packages not found under: %HOST_NM%
  echo [error] pass the dsh runtime node_modules dir as the first argument.
  exit /b 1
)

set "PLUGIN=%~dp0"
if not exist "%PLUGIN%node_modules\@deepseek-ai" mkdir "%PLUGIN%node_modules\@deepseek-ai"
for %%P in (dsh-web dsh-settings schemastery) do (
  if exist "%PLUGIN%node_modules\@deepseek-ai\%%P" (
    echo [skip ] node_modules\@deepseek-ai\%%P already exists
  ) else (
    mklink /J "%PLUGIN%node_modules\@deepseek-ai\%%P" "%HOST_NM%\@deepseek-ai\%%P" >nul
    echo [link ] node_modules\@deepseek-ai\%%P  -^>  %HOST_NM%\@deepseek-ai\%%P
  )
)
echo done. verify from the plugin dir:
echo   node -e "import('@deepseek-ai/dsh-web').then(()=^>console.log('ok'),e=^>console.log(e.message))"
