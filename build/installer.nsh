; ============================================================
; 安装 / 卸载前关闭正在运行的旧版本
;
; electron-builder 默认用 PowerShell + Get-CimInstance，按 $INSTDIR 前缀
; 匹配进程。这条路每次要 2~4 秒，而且在中文路径、提权进程、刚启动的实例上
; 容易判定失败，一旦失败就直接弹「无法正常关闭」并中止安装（用户实际踩到过）。
;
; 这里换成 taskkill：按进程名一次清干净，先温和关闭（发 WM_CLOSE，有机会落盘），
; 再强制终止（连子进程）。taskkill 返回 128 表示进程已经不存在。
; 只有真的杀不掉（多半是应用以管理员身份在跑，非提权安装程序无权结束它）
; 才提示用户手动关闭，并且允许重试。
; ============================================================

!macro customCheckAppRunning
  ; 第一遍：不带 /F，等于请它自己关掉
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R0
  ${If} $R0 == 128
    Goto check_done
  ${EndIf}

  DetailPrint "正在关闭 ${PRODUCT_NAME}…"
  Sleep 1500

  ; 第二遍：强杀，连子进程一起
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R0
  ${If} $R0 == 128
    Goto check_done
  ${EndIf}

  Sleep 1500
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Pop $R0
  ${If} $R0 == 128
    Goto check_done
  ${EndIf}

  ; 还是不行：提示用户手动处理，点「重试」再杀一次
  retry_close:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY do_retry
    Quit

  do_retry:
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
    Pop $R0
    Sleep 2000
    ${If} $R0 != 128
      Goto retry_close
    ${EndIf}

  check_done:
!macroend
