@echo off
rem 猜历史 · 开发启动（Windows 双击或命令行运行）
rem 真正的启动逻辑在 scripts/dev.mjs：环境自检、端口顺延、子进程看护都在那里
chcp 65001 >nul
cd /d "%~dp0"

node scripts\dev.mjs %*
set "EXITCODE=%ERRORLEVEL%"

rem 双击运行时窗口会一闪而过，出错时停住让用户看到原因
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%
