@echo off
rem 示例脚本：验证「点击即运行 + 日志回显」是否正常（本文件以 GBK/ANSI 编码保存）
cd /d "%~dp0"
echo ================================================
echo    示例脚本：环境自检
echo ================================================
echo.
echo [1/4] 当前工作目录：%CD%
echo [2/4] 脚本所在目录：%~dp0
echo [3/4] 参数列表：%*
echo [4/4] 中文输出测试：你好，世界。
echo       空格路径测试：C:\Program Files\Demo Tools\run.bat
echo.
if "%~1"=="--fail" goto do_fail
if "%~1"=="--sleep" goto do_sleep
goto done

:do_fail
echo [模拟失败] 故意返回退出码 3
exit /b 3

:do_sleep
echo [模拟超时] 睡 30 秒，用于验证超时强杀
ping -n 31 127.0.0.1 >nul
goto done

:done
echo.
echo 执行完毕，退出码 0
exit /b 0
