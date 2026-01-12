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

const RENT_AND_UTILITIES_FIXED = 40000;
const SHARED_SUBCATEGORIES = [
  '日用品',
  'デート（立替）',
  '外食',
  '食費',
  '普段使い（立替）',
  '旅費'
];
const FULL_REIMBURSE_SUBCATEGORY = '立替（全額）';

const TYPE_INCOME = '収入';
const TYPE_EXPENSE = '支出';
const TYPE_ADJUST = '調整';

const INCOME_HINTS = ['収入', '給与', '給料', '賞与', 'ボーナス', '入金'];
const EXPENSE_HINTS = ['支出', '出金', '支払', '立替'];
const ADJUST_HINTS = ['調整', '返金', '振替', '相殺'];
const COHABITATION_PAYMENT_HINTS = ['同棲費用'];

const INSTALLMENT_ITEMS = [
  { name: 'オスカー30回分', amount: 6865, completionDate: '2026年7月27日' },
  { name: 'テンピュール', amount: 11973, completionDate: '2027年6月27日' },
  { name: 'コンサル費用', amount: 20686, completionDate: '2026年5月27日' }
];
const DEFAULT_INSTALLMENT_DEDUCTION = INSTALLMENT_ITEMS.reduce((sum, item) => sum + item.amount, 0);

const OVERVIEW_SHEET_PREFIX = 'Overview_';
const OVERVIEW_CONFIG_SHEET = 'Overview_Config';

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

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ダッシュボード')
    .addItem('年度別Overviewを更新', 'updateOverviewSheets')
    .addToUi();
}

function updateOverviewSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheets = ss.getSheets().filter((sheet) => sheet.getName().endsWith('_CSV'));
  const rows = collectRows(sourceSheets);
  const years = Array.from(
    new Set(
      Object.keys(rows.byMonth)
        .map((key) => parseInt(key.split('-')[0], 10))
        .filter((year) => !Number.isNaN(year))
    )
  );

  if (years.length === 0) return;

  const configMap = ensureOverviewConfig(ss, years);

  years.forEach((year) => {
    const overviewSheetName = `${OVERVIEW_SHEET_PREFIX}${year}`;
    const sheet = ensureSheet(ss, overviewSheetName);
    sheet.clearContents();

    const header = [
      '月',
      '収入',
      '支出',
      '調整',
      '帳簿上収支',
      '彼女の支払額',
      '入金済み',
      '未収/過収',
      '分割払い補正',
      '実質収支'
    ];
    sheet.getRange(1, 1, 1, header.length).setValues([header]);

    const values = [];
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${month}`;
      const summary = rows.byMonth[key] || createEmptySummary();
      const config = configMap[key] || { advance: 0, installment: DEFAULT_INSTALLMENT_DEDUCTION };

      const sharedHalf = Math.floor(summary.sharedTotal / 2);
      const advanceHalf = Math.floor(config.advance / 2);
      const girlfriendPayment = RENT_AND_UTILITIES_FIXED + sharedHalf + summary.fullReimburseTotal - advanceHalf;
      const ledgerNet = summary.incomeTotal - summary.expenseTotal + summary.adjustTotal;
      const unpaidGap = girlfriendPayment - summary.girlfriendPaidActual;
      const actualNet = ledgerNet + unpaidGap - config.installment;

      values.push([
        month,
        summary.incomeTotal,
        summary.expenseTotal,
        summary.adjustTotal,
        ledgerNet,
        girlfriendPayment,
        summary.girlfriendPaidActual,
        unpaidGap,
        config.installment,
        actualNet
      ]);
    }

    sheet.getRange(2, 1, values.length, header.length).setValues(values);
    sheet.getRange(2, 2, values.length, header.length - 1).setNumberFormat('#,##0');
    sheet.setFrozenRows(1);
  });
}

function collectRows(sheets) {
  const result = { byMonth: {} };

  sheets.forEach((sheet) => {
    const rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return;

    const keys = rows[0];
    const headerMap = buildHeaderMap(keys);

    rows.slice(1).forEach((row) => {
      const dateValue = row[headerMap['日付']];
      const parsedDate = parseDate(dateValue);
      if (!parsedDate) return;

      const isTarget = String(row[headerMap['計算対象']] || '').trim() === '1';
      if (!isTarget) return;

      const year = parsedDate.getFullYear();
      const month = parsedDate.getMonth() + 1;
      const key = `${year}-${month}`;
      if (!result.byMonth[key]) result.byMonth[key] = createEmptySummary();

      const summary = result.byMonth[key];
      const amountRaw = parseAmount(row[headerMap['金額（円）']]);
      const amountAbs = Math.abs(amountRaw);
      const type = getTypeFromRow(row, headerMap);
      const subcategory = normalizeText(row[headerMap['中項目']]);

      if (type === TYPE_INCOME) {
        summary.incomeTotal += amountAbs;
        const hintSource = buildHintSource(
          row[headerMap['大項目']],
          row[headerMap['中項目']],
          row[headerMap['内容']]
        );
        if (hasHint(hintSource, COHABITATION_PAYMENT_HINTS)) {
          summary.girlfriendPaidActual += amountAbs;
        }
      }

      if (type === TYPE_EXPENSE) {
        summary.expenseTotal += amountAbs;

        if (!subcategory.includes('自費')) {
          if (subcategory === FULL_REIMBURSE_SUBCATEGORY) {
            summary.fullReimburseTotal += amountAbs;
          } else if (SHARED_SUBCATEGORIES.includes(subcategory)) {
            summary.sharedTotal += amountAbs;
          }
        }
      }

      if (type === TYPE_ADJUST) summary.adjustTotal += amountRaw;
    });
  });

  return result;
}

function ensureOverviewConfig(ss, years) {
  const sheet = ensureSheet(ss, OVERVIEW_CONFIG_SHEET);
  const header = ['年', '月', '彼女の立替入力', '分割払い補正'];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }

  const values = sheet.getDataRange().getValues();
  const map = {};
  values.slice(1).forEach((row) => {
    const year = parseInt(row[0], 10);
    const month = parseInt(row[1], 10);
    if (Number.isNaN(year) || Number.isNaN(month)) return;
    const installmentRaw = row[3];
    map[`${year}-${month}`] = {
      advance: parseAmount(row[2]),
      installment:
        installmentRaw === '' || installmentRaw === null
          ? DEFAULT_INSTALLMENT_DEDUCTION
          : parseAmount(installmentRaw)
    };
  });

  years.forEach((year) => {
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${month}`;
      if (map[key]) continue;
      sheet.appendRow([year, month, 0, DEFAULT_INSTALLMENT_DEDUCTION]);
      map[key] = { advance: 0, installment: DEFAULT_INSTALLMENT_DEDUCTION };
    }
  });

  return map;
}

function ensureSheet(ss, name) {
  const existing = ss.getSheetByName(name);
  if (existing) return existing;
  return ss.insertSheet(name);
}

function buildHeaderMap(keys) {
  const map = {};
  keys.forEach((key, index) => {
    map[String(key).trim()] = index;
  });
  return map;
}

function parseDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseAmount(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === '') return 0;
  const cleaned = String(value).replace(/,/g, '');
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeText(value) {
  return String(value || '').replace(/[\s　]+/g, '').trim();
}

function buildHintSource() {
  const parts = Array.prototype.slice.call(arguments).map((value) => normalizeText(value));
  return parts.filter(Boolean).join(' ');
}

function hasHint(text, hints) {
  return hints.some((hint) => text.indexOf(hint) !== -1);
}

function getTypeFromRow(row, headerMap) {
  const raw = normalizeText(row[headerMap['区分']]);
  if ([TYPE_INCOME, TYPE_EXPENSE, TYPE_ADJUST].includes(raw)) return raw;

  const hintSource = buildHintSource(
    raw,
    row[headerMap['大項目']],
    row[headerMap['中項目']],
    row[headerMap['内容']]
  );

  if (hasHint(hintSource, ADJUST_HINTS)) return TYPE_ADJUST;
  if (hasHint(hintSource, INCOME_HINTS)) return TYPE_INCOME;
  if (hasHint(hintSource, EXPENSE_HINTS)) return TYPE_EXPENSE;
  return TYPE_EXPENSE;
}

function createEmptySummary() {
  return {
    incomeTotal: 0,
    expenseTotal: 0,
    adjustTotal: 0,
    sharedTotal: 0,
    fullReimburseTotal: 0,
    girlfriendPaidActual: 0
  };
}
