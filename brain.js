// خدمة التحليل: كل فترة بتقرا قراءات كل مستخدم من Supabase، وتكتب نتيجة التحليل في جدول insights
import { createClient } from '@supabase/supabase-js';
import http from 'node:http';
import { analyze } from './analyze.js';
import { makeHandler } from './ask.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_EVERY_MINUTES = '60', TZ = 'Africa/Cairo', DAYS_BACK = '28' } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('ناقص SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL = 'claude-sonnet-5-5', ALLOWED_ORIGIN = '*', PORT = '8080' } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);   // service_role: على السيرفر بس

async function readings(uid, since) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('readings').select('ts,watts,minutes').eq('user_id', uid).gte('ts', since).order('ts', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
}

async function runOnce() {
  const { data: users, error } = await sb.from('user_settings').select('user_id,cfg');
  if (error) return console.error('user_settings:', error.message);
  for (const u of users || []) {
    try {
      const since = new Date(Date.now() - Number(DAYS_BACK) * 864e5).toISOString();
      const rows = await readings(u.user_id, since);
      const { data: ls } = await sb.from('latest_state').select('state').eq('user_id', u.user_id).maybeSingle();
      const cfg = u.cfg || {};
      const result = analyze(rows, { tz: TZ, used: ls?.state?.kwh, cycleStart: cfg.cycle ? new Date(cfg.cycle).getTime() : null,
        cycleDays: cfg.days || 30, tiers: cfg.tiers, prices: cfg.prices });
      const { error: e2 } = await sb.from('insights').upsert({ user_id: u.user_id, data: { ...result, generatedAt: new Date().toISOString() }, updated_at: new Date().toISOString() });
      console.log(u.user_id.slice(0, 8), result.status, `rows=${rows.length}`, e2 ? 'WRITE ERR ' + e2.message : 'ok');
    } catch (e) { console.error('user', u.user_id.slice(0, 8), e.message); }
  }
}
// ---------- المساعد الذكي (HTTP) ----------
async function callLLM(system, messages) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY مش متضاف');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, system, messages }) });
  if (!r.ok) throw new Error('LLM ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
async function loadData(uid) {
  const [s, l, i] = await Promise.all([
    sb.from('user_settings').select('cfg').eq('user_id', uid).maybeSingle(),
    sb.from('latest_state').select('state').eq('user_id', uid).maybeSingle(),
    sb.from('insights').select('data').eq('user_id', uid).maybeSingle()]);
  return { cfg: s.data?.cfg || {}, state: l.data?.state || {}, insights: i.data?.data || null };
}
const getUser = async t => { const { data, error } = await sb.auth.getUser(t); return error ? null : data.user; };
http.createServer(makeHandler({ getUser, loadData, callLLM, origin: ALLOWED_ORIGIN })).listen(Number(PORT), () => console.log('ask API on :' + PORT));

await runOnce();
setInterval(runOnce, Number(RUN_EVERY_MINUTES) * 60e3);
