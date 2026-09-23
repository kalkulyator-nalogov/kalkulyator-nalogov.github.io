// Налоговый калькулятор - логика расчёта. Без сервера, все вычисления в браузере.
// Ставки и лимиты - см. METHODOLOGY.md в корне проекта (источник и дата у каждой цифры).

const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
function fmt(n) { return RUB.format(Math.round(Math.max(0, n))) + ' ₽'; }

const CONST = {
  npd: { limit: 2400000, rateFiz: 0.04, rateUr: 0.06 },
  usn: {
    incomeLimit: 490500000,   // право на УСН вообще (450 млн * дефлятор 1,09), 2026
    vatFreeLimit: 20000000,   // без НДС, если доход не превышает эту сумму (2026, снижен с 60 млн)
    vatSpecial1: { upTo: 272500000, rate: 0.05 },
    vatSpecial2: { upTo: 490500000, rate: 0.07 },
    vatGeneral: 0.20,
    minTaxRate: 0.01,         // минимальный налог УСН "доходы минус расходы"
    staffLimit: 130
  },
  psn: {
    incomeLimit: 20000000,    // лимит дохода по патенту, 2026 (снижен с 60 млн)
    staffLimit: 15,
    excludedTypes: ['Охранные услуги'] // единственное реально исключённое направление с 2026; розница и грузоперевозки СОХРАНЕНЫ (поправка не прошла второе чтение)
  },
  osn: {
    ndflLow: { upTo: 5000000, rate: 0.13 },
    ndflHigh: 0.15,
    vat: 0.20,
    profitTaxOOO: 0.25 // налог на прибыль ООО (справочно, для статуса ИП не применяется)
  },
  insurance: { fixed: 57390, extraRate: 0.01, extraThreshold: 300000, extraCap: 321818 }
};

function calcNPD(input) {
  const { income, hasStaff, resale, excludedActivity } = input;
  const reasons = [];
  let eligible = true;
  if (hasStaff) { eligible = false; reasons.push('нельзя нанимать сотрудников по трудовым договорам'); }
  if (resale) { eligible = false; reasons.push('перепродажа товаров не подпадает под НПД'); }
  if (excludedActivity) { eligible = false; reasons.push('вид деятельности не подпадает под НПД (добыча/подакцизные товары/агентская деятельность без спецусловий)'); }
  if (income > CONST.npd.limit) { eligible = false; reasons.push(`доход выше лимита ${fmt(CONST.npd.limit)} в год`); }
  const rate = input.buyerType === 'ur' ? CONST.npd.rateUr : CONST.npd.rateFiz;
  const tax = eligible ? income * rate : null;
  return {
    key: 'npd', title: 'НПД (самозанятость)', eligible, reasons,
    tax, net: eligible ? income - tax : null,
    note: `Ставка ${Math.round(rate * 100)}% (${input.buyerType === 'ur' ? 'покупатель - юрлицо/ИП' : 'покупатель - физлицо'}). Взносы в ПФР не обязательны (пенсия не формируется, если не платить добровольно). Онлайн-касса не нужна, чек - через приложение "Мой налог".`
  };
}

function insuranceFor(income, hasStaff) {
  const extra = Math.min(Math.max(0, income - CONST.insurance.extraThreshold) * CONST.insurance.extraRate, CONST.insurance.extraCap);
  return CONST.insurance.fixed + extra;
}

function calcUsnIncome(input, rateOverride) {
  const { income, hasStaff, status } = input;
  const reasons = [];
  let eligible = status !== 'fiz';
  if (status === 'fiz') reasons.push('доступно только ИП или ООО - физлицу без регистрации нужно оформить ИП или стать самозанятым');
  if (income > CONST.usn.incomeLimit) { eligible = false; reasons.push(`доход выше лимита права на УСН ${fmt(CONST.usn.incomeLimit)}`); }
  const rate = rateOverride || 0.06;
  const insurance = status === 'ip' ? insuranceFor(income, hasStaff) : 0;
  let tax = eligible ? income * rate : null;
  let deduction = 0;
  if (eligible && tax !== null) {
    const maxDeductionShare = hasStaff ? 0.5 : 1.0;
    deduction = Math.min(tax * maxDeductionShare, insurance);
    tax = Math.max(0, tax - deduction);
  }
  const vat = eligible ? vatEstimate(income) : null;
  return {
    key: 'usn_income', title: `УСН «доходы» (${Math.round(rate * 100)}%)`, eligible, reasons,
    // "tax" - это итоговая заголовочная нагрузка (налог+взносы+НДС), чтобы её можно было
    // честно сравнивать с ОСН (там НДС всегда включён в totalTax) - иначе сортировка "лучшего
    // режима" занижает УСН при доходе выше порога НДС.
    tax: eligible ? tax + insurance + (vat ? vat.amount : 0) : null, insurance, deduction, vat,
    net: eligible ? income - tax - insurance - (vat ? vat.amount : 0) : null,
    note: `Налог ${fmt(eligible ? tax : 0)} после вычета взносов (${fmt(insurance)}), уменьшение налога ${hasStaff ? 'до 50%' : 'до 100%'} на сумму взносов. Регион может снижать ставку до 1% отдельным законом - уточните для своего региона на nalog.gov.ru.`
  };
}

function calcUsnDr(input, rateOverride) {
  const { income, expenses, hasStaff, status } = input;
  const reasons = [];
  let eligible = status !== 'fiz';
  if (status === 'fiz') reasons.push('доступно только ИП или ООО');
  if (income > CONST.usn.incomeLimit) { eligible = false; reasons.push(`доход выше лимита права на УСН ${fmt(CONST.usn.incomeLimit)}`); }
  const rate = rateOverride || 0.15;
  const insurance = status === 'ip' ? insuranceFor(income, hasStaff) : 0;
  const base = Math.max(0, income - expenses - insurance); // взносы ИП - расход (ст. 346.16 НК РФ), уменьшают базу
  let tax = eligible ? base * rate : null;
  const minTax = eligible ? income * CONST.usn.minTaxRate : null;
  if (eligible && tax < minTax) tax = minTax;
  const vat = eligible ? vatEstimate(income) : null;
  return {
    key: 'usn_dr', title: `УСН «доходы минус расходы» (${Math.round(rate * 100)}%)`, eligible, reasons,
    // см. комментарий в calcUsnIncome - НДС включаем в заголовочный "tax", иначе сравнение с ОСН нечестное
    tax: eligible ? tax + insurance + (vat ? vat.amount : 0) : null, insurance, vat,
    net: eligible ? income - tax - insurance - (vat ? vat.amount : 0) : null,
    note: `Взносы ИП уменьшают базу как расход, а не сам налог. Минимальный налог - 1% от дохода, если рассчитанный налог меньше. Регион может снижать ставку до 5% отдельным законом - уточните для своего региона.`
  };
}

function vatEstimate(income) {
  if (income <= CONST.usn.vatFreeLimit) return null;
  if (income <= CONST.usn.vatSpecial1.upTo) {
    return { rate: CONST.usn.vatSpecial1.rate, amount: income * CONST.usn.vatSpecial1.rate, kind: 'спецставка без права на вычет входящего НДС' };
  }
  if (income <= CONST.usn.vatSpecial2.upTo) {
    return { rate: CONST.usn.vatSpecial2.rate, amount: income * CONST.usn.vatSpecial2.rate, kind: 'спецставка без права на вычет входящего НДС' };
  }
  return { rate: CONST.usn.vatGeneral, amount: income * CONST.usn.vatGeneral, kind: 'общая ставка НДС с правом на вычет (вычет здесь не учтён)' };
}

function calcPsn(input) {
  const { income, hasStaff, status, excludedActivity, staffCount } = input;
  const reasons = [];
  let eligible = status === 'ip';
  if (status !== 'ip') reasons.push('патент доступен только индивидуальным предпринимателям');
  if (excludedActivity) { eligible = false; reasons.push('охранные услуги исключены из патента с 2026 года (розница и грузоперевозки на патенте сохранены)'); }
  if (income > CONST.psn.incomeLimit) { eligible = false; reasons.push(`доход выше лимита ПСН ${fmt(CONST.psn.incomeLimit)} в год (порог снижен в 2026 году)`); }
  if (hasStaff && staffCount > CONST.psn.staffLimit) { eligible = false; reasons.push(`число сотрудников выше лимита ${CONST.psn.staffLimit} человек`); }
  return {
    key: 'psn', title: 'ПСН (патент)', eligible, reasons,
    tax: null, net: null, priceUnknown: true,
    note: 'Стоимость патента считается не от фактического дохода, а от потенциально возможного дохода по вашему региону и виду деятельности - эта величина устанавливается региональным законом и здесь не считается, чтобы не гадать. Точную стоимость патента для вашего вида деятельности и региона покажет калькулятор ФНС: nalog.gov.ru (раздел «Расчёт патента»). Не знаете, разрешена ли ваша деятельность в вашем регионе? <a href="patent.html?from=kalkulyator-nalogov-psn">Подобрать деятельность и регион для патента</a>.'
  };
}

function calcOsn(input) {
  const { income, expenses, status } = input;
  const insurance = status === 'ip' ? insuranceFor(income, false) : 0;
  const base = Math.max(0, income - expenses - insurance); // взносы ИП - профвычет по НДФЛ (ст. 221 НК РФ)
  const vat = income * CONST.osn.vat; // упрощённо, без вычета входящего НДС
  let profitTax;
  if (status === 'ip') {
    const low = Math.min(base, CONST.osn.ndflLow.upTo) * CONST.osn.ndflLow.rate;
    const high = Math.max(0, base - CONST.osn.ndflLow.upTo) * CONST.osn.ndflHigh;
    profitTax = low + high;
  } else {
    profitTax = base * CONST.osn.profitTaxOOO;
  }
  const totalTax = profitTax + insurance + vat;
  return {
    key: 'osn', title: 'ОСН (общая система)', eligible: true, reasons: [],
    tax: totalTax, insurance, vat: { amount: vat, rate: CONST.osn.vat, kind: 'общая ставка, без учёта вычета входящего НДС' },
    net: income - totalTax,
    note: status === 'ip'
      ? 'НДФЛ 13% с базы до 5 млн ₽, 15% - с превышения. НДС 20% начислен упрощённо (входящий вычет не учтён - реальная нагрузка обычно ниже). Применяется по умолчанию, если другие режимы недоступны или невыгодны.'
      : 'Налог на прибыль ООО 25%. НДС 20% начислен упрощённо (входящий вычет не учтён). Применяется по умолчанию, если другие режимы недоступны.'
  };
}

function calculate(input) {
  const results = [];
  if (input.status !== 'ur') results.push(calcNPD(input));
  results.push(calcUsnIncome(input, input.usnIncomeRate));
  results.push(calcUsnDr(input, input.usnDrRate));
  if (input.status === 'ip') results.push(calcPsn(input));
  results.push(calcOsn(input));

  const eligibleResults = results.filter(r => r.eligible && r.tax !== null);
  eligibleResults.sort((a, b) => a.tax - b.tax);
  const best = eligibleResults[0] || null;

  return { results, best };
}

// ---------- UI ----------
function readInput() {
  const f = document.forms.calc;
  return {
    status: f.status.value,
    income: Number(f.income.value) || 0,
    expenses: Number(f.expenses.value) || 0,
    hasStaff: f.hasStaff.checked,
    staffCount: Number(f.staffCount.value) || 0,
    resale: f.resale.checked,
    excludedActivity: f.excludedActivity.checked,
    buyerType: f.buyerType.value,
    usnIncomeRate: Number(f.usnIncomeRate.value) / 100 || 0.06,
    usnDrRate: Number(f.usnDrRate.value) / 100 || 0.15
  };
}

function render() {
  const input = readInput();
  document.getElementById('staffCountRow').style.display = input.hasStaff ? '' : 'none';
  const { results, best } = calculate(input);
  const list = document.getElementById('results');
  list.innerHTML = '';

  if (best) {
    document.getElementById('bestBox').innerHTML = `
      <div class="verdict ok">
        <b>Похоже, выгоднее всего: ${best.title}</b><br>
        Налоговая нагрузка примерно ${fmt(best.tax)} в год, на руки останется ~${fmt(best.net)}.
      </div>`;
  } else {
    document.getElementById('bestBox').innerHTML = `<div class="verdict bad"><b>Ни один режим не подошёл по введённым условиям.</b> Проверьте статус, доход и ограничения ниже.</div>`;
  }

  results.forEach(r => {
    const div = document.createElement('div');
    div.className = 'card';
    if (r.eligible && r.tax !== null) {
      div.innerHTML = `
        <h3>${r.title}${best && r.key === best.key ? ' <span class="badge">рекомендуем</span>' : ''}</h3>
        <div class="res-row"><span>Налог + взносы в год</span><b>${fmt(r.tax)}</b></div>
        <div class="res-row"><span>Останется на руки</span><b class="g">${fmt(r.net)}</b></div>
        ${r.vat ? `<div class="res-row"><span>Из них НДС (${r.vat.kind})</span><b>${fmt(r.vat.amount)}</b></div>` : ''}
        <p class="hint">${r.note}</p>`;
    } else if (r.priceUnknown) {
      div.innerHTML = `
        <h3>${r.title}</h3>
        <div class="issues warn"><b>Стоимость патента нужно уточнить отдельно.</b><p>${r.note}</p></div>`;
    } else {
      div.innerHTML = `
        <h3>${r.title}</h3>
        <div class="issues bad"><b>Не подходит:</b><ul>${r.reasons.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
    }
    list.appendChild(div);
  });

  // Предупреждения общего характера
  const warn = document.getElementById('warnings');
  const items = [];
  if (input.income > CONST.usn.vatFreeLimit && (input.status === 'ip' || input.status === 'ur')) {
    items.push(`При доходе выше ${fmt(CONST.usn.vatFreeLimit)} в год на УСН с 2026 года возникает обязанность платить НДС (5-7% по спецставке или 20% на общих основаниях) - это уже учтено в расчёте выше.`);
  }
  if (input.hasStaff && input.status === 'ip') {
    items.push('С сотрудниками добавляются НДФЛ 13% и страховые взносы с зарплат (в этом калькуляторе не считаются - добавьте отдельно).');
  }
  warn.innerHTML = items.length ? `<div class="issues warn"><ul>${items.map(x => `<li>${x}</li>`).join('')}</ul></div>` : '';
}

document.addEventListener('DOMContentLoaded', () => {
  document.forms.calc.addEventListener('input', render);
  document.forms.calc.addEventListener('change', render);
  render();

  // UTM на партнёрскую ссылку РКО - метка источника перехода, без сохранения персональных данных у нас
  const rko = document.getElementById('rkoLink');
  if (rko) {
    const url = new URL(rko.href);
    url.searchParams.set('utm_source', 'kalkulyator-nalogov');
    url.searchParams.set('utm_medium', 'site');
    url.searchParams.set('utm_campaign', 'nalogovy_kalkulyator');
    rko.href = url.toString();
  }
});
