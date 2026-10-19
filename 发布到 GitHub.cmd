@echo off
cd /d "%~dp0"
where gh >nul 2>&1
if errorlevel 1 (
  echo 请先安装 GitHub CLI: https://cli.github.com/
  pause
  exit /b 1
)
gh auth status >nul 2>&1
if errorlevel 1 gh auth login
if errorlevel 1 (
  echo GitHub 登录失败。
  pause
  exit /b 1
)
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  gh repo create bottle-of-ocean --public --source=. --remote=origin --push
) else (
  git push -u origin HEAD
)
if errorlevel 1 (
  echo 推送失败。
  pause
  exit /b 1
)
for /f "usebackq delims=" %%u in (`gh api user --jq .login`) do set "GH_USER=%%u"
echo.
echo 请到 GitHub 仓库 Settings - Pages，把 Source 设为 GitHub Actions。
if defined GH_USER echo 网页地址: https://%GH_USER%.github.io/bottle-of-ocean/
pause
