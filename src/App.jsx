import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  List,
  Receipt,
  RefreshCw,
  Settings,
  Sparkles,
  Wallet
} from 'lucide-react';
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

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
const INSTALLMENT_DEFAULT_TOTAL = INSTALLMENT_ITEMS.reduce((sum, item) => sum + item.amount, 0);

const COLORS = ['#0F766E', '#10B981', '#F59E0B', '#F97316', '#60A5FA', '#34D399', '#F43F5E'];
const DEFAULT_GAS_URL =
  'https://script.google.com/macros/s/AKfycbxBbgtIC0A7rmRO-TxoQfSJgpagbSmN8GP0Ui_6AtfGQB40ZzMVvE8-EvzYePpoe4Rc/exec';

const readLocalStorage = (key) => {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
};

const writeLocalStorage = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    return;
  }
};

const parseYenInput = (value) => {
  const cleaned = String(value || '').replace(/[^0-9]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
};

const parseAmount = (value) => {
  const cleaned = String(value ?? '').replace(/,/g, '');
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const normalizeText = (value) => String(value || '').replace(/[\s　]+/g, '').trim();

const buildHintSource = (...values) =>
  values
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(' ');

const hasHint = (text, hints) => hints.some((hint) => text.includes(hint));

const isSubscriptionRow = (row, type) => {
  if (type !== TYPE_EXPENSE) return false;
  const major = normalizeText(row['大項目']);
  const sub = normalizeText(row['中項目']);
  const content = normalizeText(row['内容']);
  return major.includes('通信費') && (sub.includes('サブスク') || content.includes('サブスク'));
};

const getType = (row) => {
  const raw = normalizeText(row['区分']);
  if ([TYPE_INCOME, TYPE_EXPENSE, TYPE_ADJUST].includes(raw)) return raw;

  const hintSource = buildHintSource(raw, row['大項目'], row['中項目'], row['内容']);

  if (hasHint(hintSource, ADJUST_HINTS)) return TYPE_ADJUST;
  if (hasHint(hintSource, INCOME_HINTS)) return TYPE_INCOME;
  if (hasHint(hintSource, EXPENSE_HINTS)) return TYPE_EXPENSE;
  return TYPE_EXPENSE;
};

const formatYen = (value) => `¥${Math.abs(value).toLocaleString()}`;

const formatSignedYen = (value) => {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}¥${Math.abs(value).toLocaleString()}`;
};

const getSignedClass = (value) => (value >= 0 ? 'text-emerald-700' : 'text-orange-700');
const formatDeduction = (value) => (value ? `-${formatYen(value)}` : formatYen(0));

const getGirlfriendAdvanceKey = (year, month) => `girlfriend_advance_${year}-${month}`;
const getInstallmentKey = (year, month) => `installment_adjust_${year}-${month}`;

const isTargetRow = (row) => String(row['計算対象'] || '').trim() === '1';

const isSameMonth = (row, year, month) => {
  const date = new Date(row['日付']);
  if (Number.isNaN(date.getTime())) return false;
  return date.getFullYear() === year && date.getMonth() + 1 === month;
};

const buildChartData = (map, limit = 6) => {
  const entries = Object.entries(map)
    .map(([name, value]) => ({ name, value }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  if (entries.length <= limit) return entries;

  const major = entries.slice(0, limit);
  const restValue = entries.slice(limit).reduce((sum, item) => sum + item.value, 0);
  return [...major, { name: 'その他', value: restValue }];
};

const summarizeMonth = (rows, girlfriendAdvanceValue, installmentDeduction) => {
  let incomeTotal = 0;
  let expenseTotal = 0;
  let adjustTotal = 0;
  let sharedTotal = 0;
  let fullReimburseTotal = 0;
  let girlfriendPaidActual = 0;

  const ledgerDetails = [];
  const sharedDetails = [];
  const fullReimburseDetails = [];
  const expenseBySubcategory = {};
  const subscriptionDetails = [];
  let subscriptionTotal = 0;

  rows.forEach((row) => {
    const type = getType(row);
    const amountRaw = parseAmount(row['金額（円）']);
    const amountAbs = Math.abs(amountRaw);
    const subcategory = String(row['中項目'] || '').trim();
    const category = String(row['大項目'] || '').trim();

    const detail = {
      date: row['日付'],
      content: row['内容'] || '',
      category,
      subcategory,
      type,
      amount: amountRaw,
      amountAbs,
      memo: row['メモ'] || ''
    };

    ledgerDetails.push(detail);

    if (type === TYPE_INCOME) {
      incomeTotal += amountAbs;
      const paymentHintSource = buildHintSource(row['大項目'], row['中項目'], row['内容']);
      if (hasHint(paymentHintSource, COHABITATION_PAYMENT_HINTS)) {
        girlfriendPaidActual += amountAbs;
      }
    }
    if (type === TYPE_EXPENSE) expenseTotal += amountAbs;
    if (type === TYPE_ADJUST) adjustTotal += amountRaw;

    if (type === TYPE_EXPENSE) {
      const key = subcategory || category || '未分類';
      expenseBySubcategory[key] = (expenseBySubcategory[key] || 0) + amountAbs;

      if (isSubscriptionRow(row, type)) {
        subscriptionTotal += amountAbs;
        subscriptionDetails.push(detail);
      }

      if (!subcategory.includes('自費')) {
        if (subcategory === FULL_REIMBURSE_SUBCATEGORY) {
          fullReimburseTotal += amountAbs;
          fullReimburseDetails.push(detail);
        } else if (SHARED_SUBCATEGORIES.includes(subcategory)) {
          sharedTotal += amountAbs;
          sharedDetails.push(detail);
        }
      }
    }
  });

  const sharedHalf = Math.floor(sharedTotal / 2);
  const totalBilling = RENT_AND_UTILITIES_FIXED + sharedHalf + fullReimburseTotal;
  const myAdvanceTotal = RENT_AND_UTILITIES_FIXED + sharedTotal + fullReimburseTotal;
  const girlfriendAdvanceHalf = Math.floor(girlfriendAdvanceValue / 2);
  const girlfriendPayment = totalBilling - girlfriendAdvanceHalf;
  const ledgerNet = incomeTotal - expenseTotal + adjustTotal;
  const unpaidGap = girlfriendPayment - girlfriendPaidActual;
  const actualNet = ledgerNet + unpaidGap - installmentDeduction;

  return {
    ledger: {
      income: incomeTotal,
      expense: expenseTotal,
      adjust: adjustTotal,
      net: ledgerNet
    },
    billing: {
      totalBilling,
      myAdvanceTotal,
      girlfriendPayment,
      girlfriendPaidActual,
      summary: {
        rent: RENT_AND_UTILITIES_FIXED,
        shared: sharedTotal,
        sharedHalf,
        full: fullReimburseTotal,
        girlfriendAdvance: girlfriendAdvanceValue,
        girlfriendAdvanceHalf
      }
    },
    actual: {
      net: actualNet,
      gap: unpaidGap - installmentDeduction
    },
    expenseBySubcategory,
    details: {
      ledger: ledgerDetails.sort((a, b) => new Date(b.date) - new Date(a.date)),
      shared: [...sharedDetails, ...fullReimburseDetails].sort((a, b) => new Date(b.date) - new Date(a.date))
    },
    subscription: {
      total: subscriptionTotal,
      details: subscriptionDetails.sort((a, b) => new Date(b.date) - new Date(a.date))
    }
  };
};

const App = () => {
  const envGasUrl = (import.meta.env.VITE_GAS_URL || '').trim();
  const storedGasUrl = readLocalStorage('gas_url');
  const initialGasUrl = storedGasUrl || envGasUrl || DEFAULT_GAS_URL;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [gasUrl, setGasUrl] = useState(initialGasUrl);
  const [isConfiguring, setIsConfiguring] = useState(!initialGasUrl);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [girlfriendAdvanceInput, setGirlfriendAdvanceInput] = useState(() => {
    return readLocalStorage(getGirlfriendAdvanceKey(new Date().getFullYear(), new Date().getMonth() + 1)) || '';
  });
  const [installmentAdjustInput, setInstallmentAdjustInput] = useState(() => {
    return (
      readLocalStorage(getInstallmentKey(new Date().getFullYear(), new Date().getMonth() + 1)) ??
      String(INSTALLMENT_DEFAULT_TOTAL)
    );
  });

  const girlfriendAdvance = useMemo(() => parseYenInput(girlfriendAdvanceInput), [girlfriendAdvanceInput]);
  const installmentDeduction = useMemo(
    () => parseYenInput(installmentAdjustInput),
    [installmentAdjustInput]
  );

  useEffect(() => {
    const stored = readLocalStorage(getGirlfriendAdvanceKey(selectedYear, selectedMonth));
    setGirlfriendAdvanceInput(stored || '');
  }, [selectedYear, selectedMonth]);

  useEffect(() => {
    const stored = readLocalStorage(getInstallmentKey(selectedYear, selectedMonth));
    setInstallmentAdjustInput(stored ?? String(INSTALLMENT_DEFAULT_TOTAL));
  }, [selectedYear, selectedMonth]);

  const availableYears = useMemo(() => {
    if (!data) return [new Date().getFullYear()];
    const years = new Set();
    data.forEach((row) => {
      const d = new Date(row['日付']);
      if (!Number.isNaN(d.getTime())) years.add(d.getFullYear());
    });
    const sorted = Array.from(years).sort((a, b) => b - a);
    return sorted.length ? sorted : [new Date().getFullYear()];
  }, [data]);

  const fetchData = async () => {
    if (!gasUrl) return;
    setLoading(true);
    setErrorMessage('');
    try {
      const response = await fetch(gasUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('APIの応答に失敗しました');
      }
      const json = await response.json();
      if (!Array.isArray(json)) {
        throw new Error('想定外のデータ形式です');
      }
      setData(json);

      if (json.length > 0) {
        let maxDate = new Date(0);
        json.forEach((row) => {
          const d = new Date(row['日付']);
          if (!Number.isNaN(d.getTime()) && d > maxDate) {
            maxDate = d;
          }
        });
        if (maxDate.getTime() > 0) {
          setSelectedYear(maxDate.getFullYear());
          setSelectedMonth(maxDate.getMonth() + 1);
        }
      }
    } catch (error) {
      setErrorMessage('データの取得に失敗しました。URLや公開設定を確認してください。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (gasUrl && !isConfiguring) {
      fetchData();
    }
  }, [gasUrl, isConfiguring]);

  const report = useMemo(() => {
    if (!data) return null;
    const filtered = data.filter((row) => isTargetRow(row) && isSameMonth(row, selectedYear, selectedMonth));
    const summary = summarizeMonth(filtered, girlfriendAdvance, installmentDeduction);
    return {
      ...summary,
      expenseChart: buildChartData(summary.expenseBySubcategory),
      hasRows: filtered.length > 0
    };
  }, [data, selectedYear, selectedMonth, girlfriendAdvance, installmentDeduction]);

  const overviewRows = useMemo(() => {
    if (!data) return [];
    return Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      const monthRows = data.filter((row) => isTargetRow(row) && isSameMonth(row, selectedYear, month));
      const storedAdvance = readLocalStorage(getGirlfriendAdvanceKey(selectedYear, month)) || '';
      const storedInstallment = readLocalStorage(getInstallmentKey(selectedYear, month));
      const installmentValue = storedInstallment ?? String(INSTALLMENT_DEFAULT_TOTAL);
      const advanceValue = parseYenInput(storedAdvance);
      const installmentDeduction = parseYenInput(installmentValue);
      const summary = summarizeMonth(monthRows, advanceValue, installmentDeduction);
      const unpaidGap = summary.billing.girlfriendPayment - summary.billing.girlfriendPaidActual;

      return {
        month,
        income: summary.ledger.income,
        expense: summary.ledger.expense,
        adjust: summary.ledger.adjust,
        ledgerNet: summary.ledger.net,
        girlfriendPayment: summary.billing.girlfriendPayment,
        girlfriendPaidActual: summary.billing.girlfriendPaidActual,
        unpaidGap,
        installmentDeduction,
        actualNet: summary.actual.net
      };
    });
  }, [data, selectedYear, girlfriendAdvanceInput, installmentAdjustInput]);

  const overviewTotals = useMemo(() => {
    if (overviewRows.length === 0) return null;
    return overviewRows.reduce(
      (acc, row) => ({
        income: acc.income + row.income,
        expense: acc.expense + row.expense,
        adjust: acc.adjust + row.adjust,
        ledgerNet: acc.ledgerNet + row.ledgerNet,
        girlfriendPayment: acc.girlfriendPayment + row.girlfriendPayment,
        girlfriendPaidActual: acc.girlfriendPaidActual + row.girlfriendPaidActual,
        unpaidGap: acc.unpaidGap + row.unpaidGap,
        installmentDeduction: acc.installmentDeduction + row.installmentDeduction,
        actualNet: acc.actualNet + row.actualNet
      }),
      {
        income: 0,
        expense: 0,
        adjust: 0,
        ledgerNet: 0,
        girlfriendPayment: 0,
        girlfriendPaidActual: 0,
        unpaidGap: 0,
        installmentDeduction: 0,
        actualNet: 0
      }
    );
  }, [overviewRows]);

  const monthlySeries = useMemo(() => {
    return overviewRows.map((row) => ({
      label: `${row.month}月`,
      ledgerNet: row.ledgerNet,
      actualNet: row.actualNet
    }));
  }, [overviewRows]);

  const saveConfig = (event) => {
    event.preventDefault();
    const normalized = gasUrl.trim();
    if (!normalized) return;
    setGasUrl(normalized);
    writeLocalStorage('gas_url', normalized);
    setIsConfiguring(false);
  };

  if (isConfiguring) {
    return (
      <div className="ambient-bg min-h-screen">
        <div className="section-shell mx-auto flex min-h-screen max-w-lg items-center px-6 py-12">
          <div
            className="w-full rounded-3xl border border-white/70 bg-white/80 p-8 shadow-2xl backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="mb-6 flex items-center gap-2 text-emerald-700">
              <Sparkles className="h-5 w-5" />
              <p className="text-xs font-semibold tracking-[0.2em]">SETUP</p>
            </div>
            <h1 className="font-display text-2xl font-semibold text-slate-900">初期設定</h1>
            <p className="mt-2 text-sm text-slate-500">
              Google Apps ScriptのURLを設定すると、最新の家計データを取り込みます。
            </p>
            <form onSubmit={saveConfig} className="mt-6 space-y-4">
              <label className="block text-xs font-semibold text-slate-600">GAS WebアプリのURL</label>
              <input
                type="text"
                className="w-full rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-sm focus:border-emerald-400 focus:outline-none"
                placeholder="https://script.google.com/macros/s/.../exec"
                value={gasUrl}
                onChange={(event) => setGasUrl(event.target.value)}
                required
              />
              <button className="w-full rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-200 transition hover:bg-emerald-700">
                設定を保存して開始
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="ambient-bg min-h-screen">
        <div className="section-shell flex min-h-screen flex-col items-center justify-center gap-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-600" />
          <p className="text-sm text-slate-500">データを読み込み中...</p>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="ambient-bg min-h-screen">
        <div className="section-shell flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="max-w-md text-sm text-slate-500">{errorMessage}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              onClick={fetchData}
              className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-200 transition hover:bg-emerald-700"
            >
              再読み込み
            </button>
            <button
              onClick={() => setIsConfiguring(true)}
              className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-500 transition hover:bg-white/80"
            >
              URLを変更
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!report || !report.hasRows) {
    return (
      <div className="ambient-bg min-h-screen">
        <div className="section-shell flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-slate-500">選択された年月のデータが見つかりませんでした。</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              onClick={fetchData}
              className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-200 transition hover:bg-emerald-700"
            >
              再読み込み
            </button>
            <button
              onClick={() => setIsConfiguring(true)}
              className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-500 transition hover:bg-white/80"
            >
              URLを変更
            </button>
          </div>
        </div>
      </div>
    );
  }

  const ledgerNetPositive = report.ledger.net >= 0;
  const actualNetPositive = report.actual.net >= 0;
  const gapPositive = report.actual.gap >= 0;

  const getAmountClass = (type, amount) => {
    if (type === TYPE_INCOME) return 'text-emerald-600';
    if (type === TYPE_EXPENSE) return 'text-orange-600';
    return amount >= 0 ? 'text-emerald-600' : 'text-rose-600';
  };

  const formatLedgerAmount = (item) => {
    if (item.type === TYPE_INCOME) return `+${formatYen(item.amountAbs)}`;
    if (item.type === TYPE_EXPENSE) return `-${formatYen(item.amountAbs)}`;
    return formatSignedYen(item.amount);
  };

  return (
    <div className="ambient-bg min-h-screen">
      <div className="section-shell mx-auto max-w-6xl px-4 pb-16 pt-10">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1 text-xs font-semibold text-emerald-700">
              <Sparkles className="h-4 w-4" />
              帳簿上と実質のズレを可視化
            </div>
            <h1 className="font-display text-3xl font-semibold text-slate-900 md:text-4xl">
              キャッシュフロー・ダッシュボード
            </h1>
            <p className="text-sm text-slate-500">
              Google Sheets連携で、同棲費用の清算と実質収支をまとめて把握
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="flex items-center gap-2 rounded-2xl border border-white/70 bg-white/80 px-3 py-2 text-sm text-slate-600"
              style={{ boxShadow: 'var(--shadow)' }}
            >
              <Calendar className="h-4 w-4 text-emerald-600" />
              <select
                className="bg-transparent text-sm font-semibold text-slate-600 focus:outline-none"
                value={selectedYear}
                onChange={(event) => setSelectedYear(parseInt(event.target.value, 10))}
              >
                {availableYears.map((year) => (
                  <option key={year} value={year}>
                    {year}年
                  </option>
                ))}
              </select>
              <select
                className="bg-transparent text-sm font-semibold text-slate-600 focus:outline-none"
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(parseInt(event.target.value, 10))}
              >
                {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                  <option key={month} value={month}>
                    {month}月
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={fetchData}
              className="rounded-2xl border border-white/70 bg-white/80 p-2 text-emerald-600 shadow-sm transition hover:bg-white"
              title="データを更新"
            >
              <RefreshCw className="h-5 w-5" />
            </button>
            <button
              onClick={() => setIsConfiguring(true)}
              className="rounded-2xl border border-white/70 bg-white/80 p-2 text-slate-400 shadow-sm transition hover:bg-white"
              title="設定"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </header>

        <section className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div
            className="animate-rise rounded-3xl border border-white/70 bg-white/80 p-5 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)', animationDelay: '0ms' }}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold tracking-[0.2em] text-slate-400">帳簿上収支</p>
              <div
                className={`rounded-full p-2 ${
                  ledgerNetPositive ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'
                }`}
              >
                {ledgerNetPositive ? (
                  <ArrowUpRight className="h-4 w-4" />
                ) : (
                  <ArrowDownRight className="h-4 w-4" />
                )}
              </div>
            </div>
            <p
              className={`mt-4 text-2xl font-semibold ${
                ledgerNetPositive ? 'text-emerald-700' : 'text-orange-700'
              }`}
            >
              {formatSignedYen(report.ledger.net)}
            </p>
            <p className="mt-2 text-xs text-slate-500">収入 - 支出 + 調整</p>
          </div>

          <div
            className="animate-rise rounded-3xl border border-white/70 bg-white/80 p-5 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)', animationDelay: '80ms' }}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold tracking-[0.2em] text-slate-400">実質収支</p>
              <div
                className={`rounded-full p-2 ${
                  actualNetPositive ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'
                }`}
              >
                {actualNetPositive ? (
                  <ArrowUpRight className="h-4 w-4" />
                ) : (
                  <ArrowDownRight className="h-4 w-4" />
                )}
              </div>
            </div>
            <p
              className={`mt-4 text-2xl font-semibold ${
                actualNetPositive ? 'text-emerald-700' : 'text-orange-700'
              }`}
            >
              {formatSignedYen(report.actual.net)}
            </p>
            <p className="mt-2 text-xs text-slate-500">帳簿上 + 彼女の支払額 - 入金済み - 分割控除</p>
          </div>

          <div
            className="animate-rise rounded-3xl border border-white/70 bg-white/80 p-5 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)', animationDelay: '160ms' }}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold tracking-[0.2em] text-slate-400">帳簿との差分</p>
              <div
                className={`rounded-full p-2 ${
                  gapPositive ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'
                }`}
              >
                <Sparkles className="h-4 w-4" />
              </div>
            </div>
            <p
              className={`mt-4 text-2xl font-semibold ${
                gapPositive ? 'text-emerald-700' : 'text-orange-700'
              }`}
            >
              {formatSignedYen(report.actual.gap)}
            </p>
            <p className="mt-2 text-xs text-slate-500">未収/過収と分割控除の影響</p>
          </div>

          <div
            className="animate-rise rounded-3xl border border-white/70 bg-white/80 p-5 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)', animationDelay: '240ms' }}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold tracking-[0.2em] text-slate-400">彼女の支払額</p>
              <div className="rounded-full bg-emerald-100 p-2 text-emerald-700">
                <Wallet className="h-4 w-4" />
              </div>
            </div>
            <p className="mt-4 text-2xl font-semibold text-emerald-700">
              {formatYen(report.billing.girlfriendPayment)}
            </p>
            <p className="mt-2 text-xs text-slate-500">今月の精算額</p>
          </div>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div
            className="rounded-3xl border border-white/70 bg-white/80 p-6 backdrop-blur lg:col-span-2"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold tracking-[0.2em] text-slate-400">MONTHLY TREND</p>
                <h2 className="font-display text-lg font-semibold text-slate-900">帳簿上 vs 実質の推移</h2>
              </div>
              <span className="text-xs text-slate-400">{selectedYear}年</span>
            </div>
            <div className="mt-6 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlySeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `¥${Math.abs(value).toLocaleString()}`}
                  />
                  <Tooltip
                    formatter={(value) => formatSignedYen(value)}
                    labelFormatter={(label) => `${selectedYear}年${label}`}
                  />
                  <Line type="monotone" dataKey="ledgerNet" stroke="#0F766E" strokeWidth={3} dot={false} name="帳簿上" />
                  <Line type="monotone" dataKey="actualNet" stroke="#F59E0B" strokeWidth={3} dot={false} name="実質" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-600" />
                帳簿上収支
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                実質収支
              </div>
            </div>
          </div>

          <div
            className="rounded-3xl border border-white/70 bg-white/80 p-6 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-emerald-600" />
              <h2 className="font-display text-lg font-semibold text-slate-900">帳簿内訳</h2>
            </div>
            <div className="mt-6 space-y-4 text-sm text-slate-600">
              <div className="flex items-center justify-between">
                <span>収入合計</span>
                <span className="font-semibold text-emerald-600">{formatYen(report.ledger.income)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>支出合計</span>
                <span className="font-semibold text-orange-600">{formatYen(report.ledger.expense)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>調整</span>
                <span className="font-semibold text-slate-500">{formatSignedYen(report.ledger.adjust)}</span>
              </div>
            </div>
            <div className="mt-6 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3">
              <p className="text-xs font-semibold text-emerald-700">帳簿上収支</p>
              <p className="mt-1 text-xl font-semibold text-emerald-700">{formatSignedYen(report.ledger.net)}</p>
            </div>
            <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-4">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="font-semibold text-slate-600">分割払い補正</span>
                <span>未計上のカード引落</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2 text-right text-sm text-slate-600 focus:border-emerald-300 focus:outline-none"
                  placeholder={`例: ${INSTALLMENT_DEFAULT_TOTAL.toLocaleString()}`}
                  value={installmentAdjustInput}
                  onChange={(event) => {
                    const cleaned = event.target.value.replace(/[^0-9]/g, '');
                    setInstallmentAdjustInput(cleaned);
                    writeLocalStorage(getInstallmentKey(selectedYear, selectedMonth), cleaned);
                  }}
                />
                <span className="text-xs font-semibold text-slate-600">円</span>
              </div>
              <div className="mt-3 space-y-2 text-xs text-slate-500">
                {INSTALLMENT_ITEMS.map((item) => (
                  <div key={item.name} className="rounded-2xl border border-slate-100 bg-white/80 px-3 py-2">
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span className="font-semibold">{item.name}</span>
                      <span>{formatYen(item.amount)}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-slate-400">完了予定: {item.completionDate}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <div
            className="rounded-3xl border border-white/70 bg-white/80 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-emerald-600" />
                <h2 className="font-display text-lg font-semibold text-slate-900">年間Overview</h2>
              </div>
              <div className="text-xs text-slate-500">{selectedYear}年の月次収支一覧</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">月</th>
                    <th className="px-4 py-3 text-right font-medium">収入</th>
                    <th className="px-4 py-3 text-right font-medium">支出</th>
                    <th className="px-4 py-3 text-right font-medium">調整</th>
                    <th className="px-4 py-3 text-right font-medium">帳簿上収支</th>
                    <th className="px-4 py-3 text-right font-medium">彼女の支払額</th>
                    <th className="px-4 py-3 text-right font-medium">入金済み</th>
                    <th className="px-4 py-3 text-right font-medium">未収/過収</th>
                    <th className="px-4 py-3 text-right font-medium">分割補正</th>
                    <th className="px-4 py-3 text-right font-medium">実質収支</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overviewRows.map((row) => (
                    <tr key={`overview-${row.month}`} className="transition hover:bg-white/80">
                      <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{row.month}月</td>
                      <td className="px-4 py-3 text-right text-emerald-700">
                        {formatYen(row.income)}
                      </td>
                      <td className="px-4 py-3 text-right text-orange-600">
                        {formatYen(row.expense)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-500">
                        {formatSignedYen(row.adjust)}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${getSignedClass(row.ledgerNet)}`}>
                        {formatSignedYen(row.ledgerNet)}
                      </td>
                      <td className="px-4 py-3 text-right text-emerald-700">
                        {formatYen(row.girlfriendPayment)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600">
                        {formatYen(row.girlfriendPaidActual)}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${getSignedClass(row.unpaidGap)}`}>
                        {formatSignedYen(row.unpaidGap)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-500">
                        {formatDeduction(row.installmentDeduction)}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${getSignedClass(row.actualNet)}`}>
                        {formatSignedYen(row.actualNet)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {overviewTotals && (
                  <tfoot className="bg-slate-50">
                    <tr>
                      <td className="px-4 py-3 font-semibold text-slate-600">合計</td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-700">
                        {formatYen(overviewTotals.income)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-orange-600">
                        {formatYen(overviewTotals.expense)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-500">
                        {formatSignedYen(overviewTotals.adjust)}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${getSignedClass(overviewTotals.ledgerNet)}`}>
                        {formatSignedYen(overviewTotals.ledgerNet)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-700">
                        {formatYen(overviewTotals.girlfriendPayment)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-600">
                        {formatYen(overviewTotals.girlfriendPaidActual)}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${getSignedClass(overviewTotals.unpaidGap)}`}>
                        {formatSignedYen(overviewTotals.unpaidGap)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-500">
                        {formatDeduction(overviewTotals.installmentDeduction)}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${getSignedClass(overviewTotals.actualNet)}`}>
                        {formatSignedYen(overviewTotals.actualNet)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div
            className="rounded-3xl border border-white/70 bg-white/80 p-6 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-orange-500" />
              <h2 className="font-display text-lg font-semibold text-slate-900">支出カテゴリ</h2>
            </div>
            {report.expenseChart.length === 0 ? (
              <p className="mt-6 text-sm text-slate-500">支出データがありません。</p>
            ) : (
              <>
                <div className="mt-6 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={report.expenseChart}
                        dataKey="value"
                        innerRadius={60}
                        outerRadius={90}
                        paddingAngle={3}
                      >
                        {report.expenseChart.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatYen(value)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-500">
                  {report.expenseChart.map((item, index) => (
                    <div key={item.name} className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                      <span className="truncate">
                        {item.name}: {formatYen(item.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div
            className="rounded-3xl border border-white/70 bg-white/80 p-6 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex items-center gap-2">
              <List className="h-5 w-5 text-emerald-600" />
              <h2 className="font-display text-lg font-semibold text-slate-900">共同生活費サマリー</h2>
            </div>
            <div className="mt-6 space-y-4 text-sm text-slate-600">
              <div className="flex items-center justify-between">
                <span>請求額合計</span>
                <span className="font-semibold text-emerald-700">{formatYen(report.billing.totalBilling)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>自分の立替総額</span>
                <span className="font-semibold text-slate-700">{formatYen(report.billing.myAdvanceTotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>彼女の支払額</span>
                <span className="font-semibold text-emerald-700">{formatYen(report.billing.girlfriendPayment)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>入金済み</span>
                <span className="font-semibold text-slate-600">{formatYen(report.billing.girlfriendPaidActual)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>未収/過収</span>
                <span className="font-semibold text-emerald-700">
                  {formatSignedYen(report.billing.girlfriendPayment - report.billing.girlfriendPaidActual)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>分割払い補正</span>
                <span className="font-semibold text-slate-600">
                  -{formatYen(installmentDeduction)}
                </span>
              </div>
            </div>
            <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
              <div className="flex items-center justify-between">
                <span>家賃・光熱費(固定)</span>
                <span>{formatYen(report.billing.summary.rent)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>共同生活費(総額)</span>
                <span>{formatYen(report.billing.summary.shared)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>折半負担(50%)</span>
                <span>{formatYen(report.billing.summary.sharedHalf)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>立替全額(100%)</span>
                <span>{formatYen(report.billing.summary.full)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>彼女の立替入力</span>
                <span>{formatYen(report.billing.summary.girlfriendAdvance)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>差引(折半分)</span>
                <span>-{formatYen(report.billing.summary.girlfriendAdvanceHalf)}</span>
              </div>
            </div>
            <div className="mt-6 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-4">
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-emerald-700">彼女の立替入力</span>
                  <span className="text-xs text-emerald-700">折半分が差し引かれます</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="w-full rounded-2xl border border-emerald-100 bg-white px-4 py-2 text-right text-sm text-slate-600 focus:border-emerald-300 focus:outline-none"
                    placeholder="例: 12000"
                    value={girlfriendAdvanceInput}
                    onChange={(event) => {
                      const cleaned = event.target.value.replace(/[^0-9]/g, '');
                      setGirlfriendAdvanceInput(cleaned);
                      writeLocalStorage(getGirlfriendAdvanceKey(selectedYear, selectedMonth), cleaned);
                    }}
                  />
                  <span className="text-xs font-semibold text-emerald-700">円</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <div
            className="rounded-3xl border border-white/70 bg-white/80 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
              <div className="flex items-center gap-2">
                <Receipt className="h-5 w-5 text-indigo-500" />
                <h2 className="font-display text-lg font-semibold text-slate-900">サブスク明細（通信費）</h2>
              </div>
              <div className="text-xs text-slate-500">
                合計 {formatYen(report.subscription.total)} / {report.subscription.details.length} 件
              </div>
            </div>
            {report.subscription.details.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-slate-500">
                該当するサブスクはありません。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-6 py-3 font-medium">日付</th>
                      <th className="px-6 py-3 font-medium">内容 / メモ</th>
                      <th className="px-6 py-3 text-right font-medium">金額</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.subscription.details.map((item, index) => (
                      <tr key={`${item.date}-${index}`} className="transition hover:bg-white/80">
                        <td className="px-6 py-4 text-slate-500 whitespace-nowrap">{item.date}</td>
                        <td className="px-6 py-4">
                          <div className="font-medium text-slate-900 line-clamp-2" title={item.content}>
                            {item.content}
                          </div>
                          {item.memo && <div className="mt-1 text-xs text-slate-400 italic">{item.memo}</div>}
                        </td>
                        <td className="px-6 py-4 text-right font-semibold text-slate-700 whitespace-nowrap">
                          -{formatYen(item.amountAbs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-6">
          <div
            className="rounded-3xl border border-white/70 bg-white/80 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex items-center gap-2 border-b border-slate-100 px-6 py-4">
              <List className="h-5 w-5 text-emerald-600" />
              <h2 className="font-display text-lg font-semibold text-slate-900">取引明細</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-6 py-3 font-medium">日付</th>
                    <th className="px-6 py-3 font-medium">内容 / メモ</th>
                    <th className="px-6 py-3 font-medium">区分</th>
                    <th className="px-6 py-3 text-right font-medium">金額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.details.ledger.map((item, index) => (
                    <tr key={`${item.date}-${index}`} className="transition hover:bg-white/80">
                      <td className="px-6 py-4 text-slate-500 whitespace-nowrap">{item.date}</td>
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-900 line-clamp-2" title={item.content}>
                          {item.content}
                        </div>
                        {item.memo && <div className="mt-1 text-xs text-slate-400 italic">{item.memo}</div>}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                            item.type === TYPE_INCOME
                              ? 'bg-emerald-100 text-emerald-700'
                              : item.type === TYPE_EXPENSE
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {item.type}
                        </span>
                      </td>
                      <td className={`px-6 py-4 text-right font-semibold ${getAmountClass(item.type, item.amount)}`}>
                        {formatLedgerAmount(item)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div
            className="rounded-3xl border border-white/70 bg-white/80 backdrop-blur"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            <div className="flex items-center gap-2 border-b border-slate-100 px-6 py-4">
              <Receipt className="h-5 w-5 text-orange-500" />
              <h2 className="font-display text-lg font-semibold text-slate-900">共同生活費明細</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-6 py-3 font-medium">日付</th>
                    <th className="px-6 py-3 font-medium">内容 / メモ</th>
                    <th className="px-6 py-3 font-medium">中項目</th>
                    <th className="px-6 py-3 text-right font-medium">金額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.details.shared.length === 0 ? (
                    <tr>
                      <td className="px-6 py-6 text-center text-sm text-slate-500" colSpan={4}>
                        共同生活費の対象データがありません。
                      </td>
                    </tr>
                  ) : (
                    report.details.shared.map((item, index) => (
                      <tr key={`${item.date}-${index}`} className="transition hover:bg-white/80">
                        <td className="px-6 py-4 text-slate-500 whitespace-nowrap">{item.date}</td>
                        <td className="px-6 py-4">
                          <div className="font-medium text-slate-900 line-clamp-2" title={item.content}>
                            {item.content}
                          </div>
                          {item.memo && <div className="mt-1 text-xs text-slate-400 italic">{item.memo}</div>}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span
                            className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                              item.subcategory === FULL_REIMBURSE_SUBCATEGORY
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}
                          >
                            {item.subcategory}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right font-semibold text-slate-700 whitespace-nowrap">
                          {formatYen(item.amountAbs)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default App;
