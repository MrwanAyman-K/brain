// تحليل الاستهلاك: نمط الساعة × يوم الأسبوع → توقع باقي الدورة + كشف الاستهلاك الغريب
export const TIERS = [50, 100, 200, 350, 650, 1000];
export const PRICES = [0.68, 0.8736, 1.064, 1.736, 2.184, 2.352, 2.89];   // تقديرية، بتتاخد من إعدادات المستخدم لو موجودة
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

export function billCost(kwh, tiers = TIERS, prices = PRICES) {
  let c = 0, prev = 0; if (!(kwh > 0)) return 0;
  for (let i = 0; i <= tiers.length; i++) {
    const hi = i < tiers.length ? tiers[i] : Infinity, pr = prices[i] != null ? prices[i] : prices[prices.length - 1];
    c += Math.max(0, Math.min(kwh, hi) - prev) * pr; prev = hi; if (kwh <= hi) break;
  } return c;
}

function mkLocal(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' });
  return ts => { const p = {}; for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value; return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, wd: p.weekday }; };
}

// rows: [{ts, watts, minutes}] — ctx: {now, tz, used, cycleStart(ms), cycleDays, tiers, prices}
export function analyze(rows, ctx = {}) {
  const now = ctx.now ?? Date.now(), tz = ctx.tz || 'Africa/Cairo', tiers = ctx.tiers || TIERS, prices = ctx.prices || PRICES;
  const loc = mkLocal(tz), keyOf = l => l.day + '|' + l.hour, nowKey = keyOf(loc(now));

  // 1) تجميع القراءات في ساعات. كل قراءة بتغطي أقصى 15 دقيقة (علشان الفجوات ما تتحسبش استهلاك)
  const B = new Map();
  for (const r of rows) {
    const mins = Math.min(15, Math.max(0, +r.minutes || 0)); if (!mins || !(r.watts >= 0)) continue;
    const l = loc(new Date(r.ts).getTime()), k = keyOf(l);
    let b = B.get(k); if (!b) { b = { k, day: l.day, hour: l.hour, wd: l.wd, kwh: 0, min: 0 }; B.set(k, b); }
    b.kwh += r.watts * mins / 60 / 1000; b.min += mins;
  }
  // ساعات كاملة بتغطية ≥ 30 دقيقة (والساعة الحالية مستبعدة)، وبنكبّر الناقص لحد ساعة
  const all = [...B.values()].filter(b => b.k !== nowKey && b.min >= 30).map(b => ({ ...b, x: b.kwh * Math.min(2, 60 / b.min) }));
  const days = new Set(all.map(h => h.day)).size;
  if (all.length < 48 || days < 3)
    return { status: 'need_data', hoursCovered: all.length, daysCovered: days,
      message: `محتاج بيانات أكتر: عندي ${all.length} ساعة قياس من ${days} يوم. التحليل بيبدأ من 48 ساعة (والأفضل أسبوعين متواصلين).` };

  // 2) آخر 3 ساعات بنقارنها بالمعتاد، فنستبعدها من خط الأساس علشان ما تلوّثوش
  const recent = [1, 2, 3].map(i => keyOf(loc(now - i * 36e5)));
  const base = all.filter(h => !recent.includes(h.k));
  const slot = new Map(), hod = new Map();
  for (const h of base) {
    const s = h.wd + '|' + h.hour; (slot.get(s) || slot.set(s, []).get(s)).push(h.x);
    (hod.get(h.hour) || hod.set(h.hour, []).get(h.hour)).push(h.x);
  }
  const overall = mean(base.map(h => h.x));
  const hodMean = hr => hod.has(hr) ? mean(hod.get(hr)) : overall;
  const slotMean = l => { const a = slot.get(l.wd + '|' + l.hour); return a && a.length >= 2 ? mean(a) : hodMean(l.hour); };
  const slotStd = l => { const a = slot.get(l.wd + '|' + l.hour); return a && a.length >= 3 ? std(a) : 0; };
  const hourly = Array.from({ length: 24 }, (_, h) => +hodMean(h).toFixed(3));

  // 3) توقع باقي الدورة
  let forecast = null;
  if (ctx.used != null && ctx.cycleStart) {
    const end = ctx.cycleStart + (ctx.cycleDays || 30) * 864e5;
    let exp = 0, hrs = 0;
    for (let t = Math.ceil(now / 36e5) * 36e5; t < end; t += 36e5) { exp += slotMean(loc(t)); hrs++; }
    const byDay = new Map(); for (const h of base) { const o = byDay.get(h.day) || { s: 0, c: 0 }; o.s += h.x; o.c++; byDay.set(h.day, o); }
    const dt = [...byDay.values()].filter(o => o.c >= 20).map(o => o.s * 24 / o.c);
    const sd = dt.length >= 3 ? std(dt) : 0.15 * overall * 24;
    const daysLeft = hrs / 24, unc = sd * Math.sqrt(daysLeft);
    const f = ctx.used + exp, lo = Math.max(ctx.used, f - unc), hi = f + unc;
    forecast = { kwh: +f.toFixed(1), lo: +lo.toFixed(1), hi: +hi.toFixed(1), daysLeft: +daysLeft.toFixed(1), dailyAvg: +(overall * 24).toFixed(2),
      cost: Math.round(billCost(f, tiers, prices)), costLo: Math.round(billCost(lo, tiers, prices)), costHi: Math.round(billCost(hi, tiers, prices)) };
  }

  // 4) كشف الاستهلاك الغريب: ≥ ساعتين من آخر 3 أعلى من المعتاد بوضوح
  const byKey = new Map(all.map(h => [h.k, h]));
  let hi = 0, n = 0, sx = 0, sm = 0;
  for (let i = 1; i <= 3; i++) {
    const l = loc(now - i * 36e5), h = byKey.get(keyOf(l)); if (!h) continue;
    const m = slotMean(l), sigma = Math.max(slotStd(l), 0.15 * m + 0.05);
    n++; sx += h.x; sm += m; if ((h.x - m) / sigma > 3 && h.x > 1.5 * m) hi++;
  }
  const pct = sm > 0 ? Math.round((sx / sm - 1) * 100) : 0;
  const anomaly = n >= 2 && hi >= 2
    ? { level: 'high', pct, text: `استهلاكك في آخر ${n} ساعات أعلى من المعتاد لنفس الوقت بحوالي ${pct}% (${(sx / n).toFixed(2)} كيلووات/ساعة بدل ${(sm / n).toFixed(2)}). راجع الأجهزة الشغالة.` }
    : { level: 'ok', pct, text: n >= 2 ? 'استهلاكك في آخر ساعات طبيعي بالنسبة للمعتاد.' : 'مفيش قراءات كفاية في آخر 3 ساعات للمقارنة.' };

  return { status: 'ok', hoursCovered: all.length, daysCovered: days, forecast, anomaly, hourly };
}
