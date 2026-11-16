; ============================================================
; 安装 / 卸载前结束正在运行的旧版本
;
; 为什么不用 electron-builder 的默认实现：
; 它用 PowerShell + Get-CimInstance，按 $INSTDIR 路径前缀匹配进程再 Stop-Process。
; 这条路每次要 2~4 秒，而且在没有管理员权限时会失败——一旦失败就直接弹
; 「暧 无法关闭」并中止安装（实测：装到 D:\Program Files 下必然踩到）。
;
; 这里改成按进程名 taskkill：
;   1. 先不带 /F，等于请它自己关掉，有机会把数据落盘；
;   2. 还在就 /F 强制结束，连子进程一起；
;   3. 仍然不阻塞安装——杀不掉通常是权限问题，让后面的文件写入错误去暴露真正原因，
;      而不是在这儿弹一个「无法关闭」把用户卡死（应用本身没有未保存状态，强杀是安全的）。
;
; taskkill 返回 128 = 进程本来就不存在，直接跳过。
; ============================================================

!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R0
  ${If} $R0 == 128
    Goto check_done
  ${EndIf}

  DetailPrint "正在关闭 ${PRODUCT_NAME}…"
  Sleep 1200

  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R0
  Sleep 800

  check_done:
!macroend
