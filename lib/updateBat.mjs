// 更新重啟批次腳本（main.mjs 與測試共用）
// 參數：%~1=新檔路徑（.new） %~2=原 exe 路徑 %~3=nostart（測試用，不啟動）
// 邏輯：重試 30 次移動（每次約 1 秒，覆蓋防毒掃描/檔案解鎖延遲）→ 成功啟動新版；
//       失敗（檔案持續被鎖）則啟動舊版並保留 .new 供手動更新。
// 不自刪（自刪會讓 cmd 讀不到下一行而回 1），殘留批次由程式下次啟動時清理。
export function updateBatBody() {
  return [
    '@echo off',
    'setlocal',
    'set /a tries=0',
    ':retry',
    'ping -n 2 127.0.0.1 >nul',
    'move /y "%~1" "%~2" >nul 2>&1',
    'if not exist "%~1" goto done',
    'set /a tries+=1',
    'if %tries% LSS 30 goto retry',
    ':done',
    'if /i "%~3"=="nostart" exit /b 0',
    'start "" "%~2"',
    'exit /b 0',
  ].join('\r\n');
}
