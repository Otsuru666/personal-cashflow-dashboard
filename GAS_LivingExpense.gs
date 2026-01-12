/**
 * Google Apps Script: スプレッドシートのデータをJSONとして公開する
 * 
 * 使い方:
 * 1. スプレッドシートの「拡張機能」>「Apps Script」を開く
 * 2. このコードを貼り付ける
 * 3. 右上の「デプロイ」>「新しいデプロイ」を選択
 * 4. 種類を「ウェブアプリ」に、アクセスできるユーザーを「全員」にしてデプロイ
 * 5. 発行されたURLをダッシュボードの初期設定画面に入力
 */

function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  let allData = [];

  sheets.forEach(sheet => {
    const sheetName = sheet.getName();
    // 「2026_CSV」のように年度が含まれるシートのみを対象にする
    if (!sheetName.endsWith("_CSV")) return;

    const rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return; // ヘッダーのみ、または空のシートはスキップ

    const keys = rows[0];
    const sheetData = rows.slice(1).map(row => {
      const obj = {};
      keys.forEach((key, i) => {
        let val = row[i];
        // 日付型の場合はYYYY-MM-DD形式の文字列に変換
        if (val instanceof Date) {
          val = Utilities.formatDate(val, "JST", "yyyy-MM-dd");
        }
        obj[key] = val;
      });
      return obj;
    });
    allData = allData.concat(sheetData);
  });

  return ContentService.createTextOutput(JSON.stringify(allData))
    .setMimeType(ContentService.MimeType.JSON);
}
