@echo off
chcp 65001 >nul
title Purchase Summary Console
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py
) else (
  where py >nul 2>nul
  if %errorlevel%==0 (
    py serve.py
  ) else (
    echo Python not found. Please install Python 3 first: https://www.python.org/downloads/
  )
)
pause
