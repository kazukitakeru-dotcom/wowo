'use strict';

/* ==========================================================================
   URUOI 水分管理 — 複数端末同期（Supabase）

   このアプリのデータは「1日1杯ずつ積み上げた記録」なので、
   状態を丸ごと last-write-wins にすると、片方の端末で飲んだ分が消える。
   そのため記録は「追記イベント」として1杯=1行で同期する。

   ・飲んだ記録 …… 追記マージ。内容は後から変わらないので衝突しない。
                    消したものは墓標で伝え、いちど消えたら復活させない（削除優先）。
   ・日ごとの目標 … 1日1行の last-write-wins。
   ・設定と水知識 … 項目ごとにマージ。
                    水知識は両端末で別々に進むので、解禁は和集合・進行度は最大値。
                    ここを last-write-wins にすると集めたスタンプが巻き戻る。

   外部ライブラリは使わない（PWAをオフラインで完結させるため fetch で直接叩く）。
   ========================================================================== */

const SB_URL = 'https://kafaarlosuvqxxlxpvgg.supabase.co';
const SB_KEY = 'sb_publishable_nSwOQo-YbEtDN_KTjBf80w_D6o0iLoA';

const SESSION_KEY    = 'uruoi_session_v1';
const SYNC_STATE_KEY = 'uruoi_sync_state_v1';
const ROLLBACK_KEY   = 'uruoi_rollback_v1';

// サーバー時刻でも「commit の順番」と now() は完全には一致しないので、
// 前回取得位置を少しだけ巻き戻して取りこぼしを防ぐ。重複して取っても害はない。
const PULL_MARGIN_MS = 5000;

const PAGE_SIZE = 1000; // PostgREST の1回あたり上限に合わせる

// ========== アプリ本体への入り口 ==========
function app() { return window.URUOI; }
function appState() { return window.URUOI.getState(); }

// ========== セッション ==========
function sbLoadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}
function sbSaveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function sbIsLoggedIn() { return !!(sbLoadSession() || {}).refresh_token; }

function _storeSession(json) {
  if (!json || !json.access_token) return null;
  const prev = sbLoadSession() || {};
  const s = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    user_id: (json.user && json.user.id) || prev.user_id || null,
    email: (json.user && json.user.email) || prev.email || null,
  };
  sbSaveSession(s);
  return s;
}

async function _authFetch(path, body) {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.msg || json.message || `HTTP ${res.status}`);
  }
  return json;
}

async function sbSignUp(email, password) {
  const json = await _authFetch('signup', { email, password });
  if (!json.access_token) return { needsConfirmation: true }; // メール確認が有効な場合
  _storeSession(json);
  return { needsConfirmation: false };
}

async function sbSignIn(email, password) {
  _storeSession(await _authFetch('token?grant_type=password', { email, password }));
}

function sbSignOut() {
  sbSaveSession(null);
  _saveSyncState(null);
}

// 有効なアクセストークンを返す（期限が近ければ更新する）
async function sbAccessToken() {
  const s = sbLoadSession();
  if (!s || !s.refresh_token) return null;
  if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
  try {
    const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    return _storeSession(json).access_token;
  } catch (e) {
    // リフレッシュトークンが失効している＝ログインし直しが必要
    if (/invalid|expired|not found/i.test(e.message)) sbSaveSession(null);
    throw e;
  }
}

// ========== データAPI ==========
async function _rest(path, { method = 'GET', body = null, prefer = null } = {}) {
  const token = await sbAccessToken();
  if (!token) throw new Error('ログインしていません');
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  if (method === 'GET' || (prefer || '').includes('return=representation')) {
    return res.json().catch(() => []);
  }
  return null;
}

// 1回のGETには件数上限があるので、全部取れるまでページを送る。
// 記録は1日数件ずつ増えるので、1年も使えば上限を超える。
async function _restAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await _rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

// 送信も件数が多いと弾かれるので小分けにする
async function _restUpsert(path, rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await _rest(path, {
      method: 'POST',
      body: rows.slice(i, i + CHUNK),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}

// ========== 変更検出 ==========
// JSON全体を控えると重いので、短いハッシュで「変わったか」だけ見る
function _hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 31 + (h2 << 3)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36) + '-' + str.length.toString(36);
}

function _emptySyncState() {
  return {
    initialized: false,
    lastPulledAt: null,
    entries: {},  // 送信済みで、サーバーに存在する記録のID
    tombs: {},    // 削除として送信済みの記録のID
    days: {},     // 'YYYY-MM-DD' -> 目標のハッシュ
    docHash: {},  // 設定の項目 -> ハッシュ
    rev: {},      // 設定の項目 -> 最後にこの端末で変えた時刻(ms)
    lastSyncedAt: null,
  };
}
function _loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || 'null');
    return (s && typeof s === 'object') ? Object.assign(_emptySyncState(), s) : _emptySyncState();
  } catch (e) { return _emptySyncState(); }
}
function _saveSyncState(s) {
  if (s) localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
  else localStorage.removeItem(SYNC_STATE_KEY);
}

// ========== 取り込み前の巻き戻し用スナップショット ==========
// クラウドの内容を反映する直前に、この端末のデータを丸ごと控えておく。
// 万一おかしくなっても1タップで戻せるようにするための保険。
function saveRollback(reason) {
  try {
    const raw = localStorage.getItem(app().KEY);
    if (!raw) return;
    localStorage.setItem(ROLLBACK_KEY, JSON.stringify({ at: Date.now(), reason, data: raw }));
  } catch (e) { /* 保険が取れなくても本処理は止めない */ }
}

function rollbackInfo() {
  try {
    const snap = JSON.parse(localStorage.getItem(ROLLBACK_KEY) || 'null');
    if (!snap || !snap.data) return null;
    const parsed = JSON.parse(snap.data);
    let n = 0;
    for (const rec of Object.values(parsed.daily || {})) n += ((rec && rec.entries) || []).length;
    return { at: snap.at, count: n };
  } catch (e) { return null; }
}

async function restoreRollback() {
  const snap = JSON.parse(localStorage.getItem(ROLLBACK_KEY) || 'null');
  if (!snap || !snap.data) { alert('戻せる控えがありません。'); return; }
  const info = rollbackInfo();
  const when = new Date(snap.at).toLocaleString('ja-JP');
  if (!confirm(`${when} 時点の内容（記録${info ? info.count : '?'}件）に戻します。\n今この端末にあるデータは置き換わります。よろしいですか？`)) return;

  localStorage.setItem(app().KEY, snap.data);
  // 送信済みの目印を消して、戻した内容を改めてクラウドへ反映させる
  _saveSyncState(null);
  alert('戻しました。再読み込みします。');
  location.reload();
}

// ========== 同期本体 ==========
let _syncing = false;
let _syncTimer = null;
let _lastSyncError = null;

function scheduleSync(delay = 2500) {
  if (!sbIsLoggedIn()) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

// アプリ本体の saveState から呼ばれる
window.uruoiOnLocalChange = function () { scheduleSync(); };

// この端末で初めて同期するときだけ、合流するか置き換えるかを決める。
// 端末に記録が無ければ迷う余地がないので何も聞かない。
function firstSyncSetup(sync) {
  if (sync.initialized) return;
  const st = appState();
  let n = 0;
  for (const rec of Object.values(st.daily || {})) n += ((rec && rec.entries) || []).length;

  if (n > 0) {
    saveRollback('初回同期の前');
    const merge = confirm(
      `この端末には ${n}件 の記録があります。\n\n` +
      `［OK］この端末の記録もクラウドに合流させる\n` +
      `［キャンセル］クラウドの内容だけを取り込む\n\n` +
      `どちらを選んでも、今の内容は控えに保存され、あとから戻せます。`
    );
    if (!merge) {
      st.daily = {};
      st.deletedEntries = {};
      app().commit();
      app().rerender();
    }
  }
  sync.initialized = true;
  _saveSyncState(sync);
}

async function syncNow(opts = {}) {
  if (_syncing) return;
  if (!sbIsLoggedIn()) return;
  if (!navigator.onLine) { _lastSyncError = 'オフライン'; updateSyncUI(); return; }

  _syncing = true;
  updateSyncUI();
  try {
    const sync = _loadSyncState();
    firstSyncSetup(sync);
    await _pull(sync);
    await _push(sync);
    sync.lastSyncedAt = Date.now();
    _saveSyncState(sync);
    _lastSyncError = null;
    if (opts.toast) alert('同期しました');
  } catch (e) {
    _lastSyncError = e.message || String(e);
    if (opts.toast) alert('同期に失敗しました：' + _lastSyncError);
  } finally {
    _syncing = false;
    updateSyncUI();
  }
}

// ---- 取得 ----
async function _pull(sync) {
  const since = sync.lastPulledAt ? `&updated_at=gt.${encodeURIComponent(sync.lastPulledAt)}` : '';
  const [remoteEntries, remoteDays, remoteState] = await Promise.all([
    _restAll(`uruoi_entries?select=id,date,t,ml,deleted,updated_at&order=updated_at.asc,id.asc${since}`),
    _restAll(`uruoi_days?select=date,target_ml,updated_at&order=updated_at.asc,date.asc${since}`),
    _rest('uruoi_state?select=doc,updated_at&limit=1'),
  ]);

  const remoteDoc = (remoteState && remoteState[0] && remoteState[0].doc) || null;
  if (!remoteEntries.length && !remoteDays.length && !remoteDoc) return;

  // これから端末のデータを書き換えるので、直前の状態を控えておく
  saveRollback('取り込み前');

  const st = appState();
  if (!st.daily) st.daily = {};
  if (!st.deletedEntries) st.deletedEntries = {};

  let newest = null;
  const bump = ts => { if (ts && (!newest || ts > newest)) newest = ts; };

  // --- 飲んだ記録（追記マージ／削除優先） ---
  if (remoteEntries.length) {
    // どの記録がどの日に入っているかの索引を1回だけ作る
    const dayOf = new Map();
    for (const [dateKey, rec] of Object.entries(st.daily)) {
      for (const e of (rec && rec.entries) || []) if (e && e.id) dayOf.set(e.id, dateKey);
    }

    for (const row of remoteEntries) {
      bump(row.updated_at);

      if (row.deleted) {
        sync.tombs[row.id] = 1;
        delete sync.entries[row.id];
        // 手元にも墓標を残す。残さないと、次回この記録を持つ端末から押し戻される。
        if (!st.deletedEntries[row.id]) {
          st.deletedEntries[row.id] = { d: row.date, at: Date.parse(row.updated_at) || Date.now() };
        }
        const dk = dayOf.get(row.id);
        if (dk && st.daily[dk]) {
          const arr = st.daily[dk].entries || [];
          const i = arr.findIndex(e => e && e.id === row.id);
          if (i !== -1) arr.splice(i, 1);
          dayOf.delete(row.id);
        }
        continue;
      }

      sync.entries[row.id] = 1;
      // こちらで消した記録は、相手がまだ持っていても復活させない
      if (st.deletedEntries[row.id]) continue;
      if (dayOf.has(row.id)) continue;

      const dk = row.date || app().dateKeyLocal();
      if (!st.daily[dk]) st.daily[dk] = { targetMl: null, entries: [] };
      if (!Array.isArray(st.daily[dk].entries)) st.daily[dk].entries = [];
      st.daily[dk].entries.push({ id: row.id, t: Number(row.t) || 0, ml: Number(row.ml) || 0 });
      dayOf.set(row.id, dk);
    }

    // 記録は時刻順に並んでいる前提で表示・累計を出しているので並べ直す
    for (const rec of Object.values(st.daily)) {
      if (rec && Array.isArray(rec.entries)) rec.entries.sort((a, b) => (a.t || 0) - (b.t || 0));
    }
  }

  // --- 日ごとの目標（last-write-wins） ---
  for (const row of remoteDays) {
    bump(row.updated_at);
    const dk = row.date;
    const local = st.daily[dk];
    const localHash = _hash(String(local ? (local.targetMl ?? null) : null));
    // この端末にまだ送っていない変更があるなら、そちらを残す（送信側で相手に反映される）
    if (local && sync.days[dk] !== undefined && sync.days[dk] !== localHash) continue;

    if (!st.daily[dk]) st.daily[dk] = { targetMl: null, entries: [] };
    st.daily[dk].targetMl = (row.target_ml === null || row.target_ml === undefined)
      ? null : Number(row.target_ml);
    sync.days[dk] = _hash(String(st.daily[dk].targetMl ?? null));
  }

  // --- 設定・水知識（項目ごとのマージ） ---
  if (remoteDoc) {
    bump(remoteState[0].updated_at);
    _mergeDoc(sync, st, remoteDoc);
  }

  if (newest) {
    // commit の順と now() のわずかなズレで取りこぼさないよう、少しだけ巻き戻す
    sync.lastPulledAt = new Date(Date.parse(newest) - PULL_MARGIN_MS).toISOString();
  }

  app().commit();
  app().rerender();
  // 取り込んだ分で今日の目標に届いたなら、スタンプもここで解禁する
  try { app().awardKnowledgeIfAchieved(); } catch (e) {}
}

// 設定と水知識のマージ。
// ここがこのアプリで一番間違えやすいところなので、項目ごとに規則を分けている。
function _mergeDoc(sync, st, remote) {
  const rRev = (remote.rev && typeof remote.rev === 'object') ? remote.rev : {};
  const takeRemote = (field) => (Number(rRev[field]) || 0) > (Number(sync.rev[field]) || 0);

  // --- 後に変えた方が勝つ項目 ---
  if (remote.profile && takeRemote('profile')) {
    st.profile = remote.profile;
    sync.rev.profile = Number(rRev.profile) || 0;
    sync.docHash.profile = _hash(JSON.stringify(st.profile));
  }
  if (Array.isArray(remote.quickAdds) && takeRemote('quickAdds')) {
    st.quickAdds = remote.quickAdds;
    sync.rev.quickAdds = Number(rRev.quickAdds) || 0;
    sync.docHash.quickAdds = _hash(JSON.stringify(st.quickAdds));
  }

  // --- 区切り時間は「いつから何時」の履歴なので、両端末の分を時系列に合流させる ---
  // 丸ごと上書きすると、片方の端末で設定した区切りが無かったことになり、
  // 過去の集計日がずれて記録が別の日に移動して見える。
  if (remote.settings && Array.isArray(remote.settings.rolloverRules)) {
    if (!st.settings) st.settings = { rolloverRules: [] };
    const byTs = new Map();
    for (const r of st.settings.rolloverRules || []) byTs.set(Number(r.fromTs) || 0, r);
    for (const r of remote.settings.rolloverRules) {
      const ts = Number(r.fromTs) || 0;
      // 同じ時刻に別々の設定が入っていたら、後に変えた端末の方を採る
      if (!byTs.has(ts) || takeRemote('settings')) byTs.set(ts, r);
    }
    st.settings.rolloverRules = [...byTs.values()]
      .map(r => ({ fromTs: Number(r.fromTs) || 0, hour: Math.max(0, Math.min(23, Number(r.hour) || 0)) }))
      .sort((a, b) => a.fromTs - b.fromTs);
    if (takeRemote('settings')) sync.rev.settings = Number(rRev.settings) || 0;
    sync.docHash.settings = _hash(JSON.stringify(st.settings));
  }

  // --- 水知識は「集めたもの」なので、消える方向のマージは絶対にしない ---
  const rk = remote.knowledge;
  if (rk && typeof rk === 'object') {
    if (!st.knowledge) st.knowledge = { unlocked: [], awardedByDate: {}, seriesIndex: {}, activeSeries: 'A' };
    // 解禁済みは和集合
    if (Array.isArray(rk.unlocked)) {
      st.knowledge.unlocked = [...new Set([...(st.knowledge.unlocked || []), ...rk.unlocked])];
    }
    // その日に出したスタンプは、先に入っている方を残す
    for (const [d, id] of Object.entries(rk.awardedByDate || {})) {
      if (st.knowledge.awardedByDate[d] === undefined) st.knowledge.awardedByDate[d] = id;
    }
    // シリーズの進行度は進んでいる方
    for (const [s, idx] of Object.entries(rk.seriesIndex || {})) {
      const cur = Number(st.knowledge.seriesIndex[s]) || 0;
      st.knowledge.seriesIndex[s] = Math.max(cur, Number(idx) || 0);
    }
    if (rk.activeSeries && takeRemote('activeSeries')) {
      st.knowledge.activeSeries = rk.activeSeries;
      sync.rev.activeSeries = Number(rRev.activeSeries) || 0;
    }
    sync.docHash.knowledge = _hash(JSON.stringify(st.knowledge));
  }
}

// ---- 送信 ----
async function _push(sync) {
  const userId = (sbLoadSession() || {}).user_id;
  if (!userId) throw new Error('ユーザーIDが取れません');

  const st = appState();
  const now = Date.now();

  // --- 飲んだ記録（まだ送っていないものだけ） ---
  const rows = [];
  for (const [dateKey, rec] of Object.entries(st.daily || {})) {
    for (const e of (rec && rec.entries) || []) {
      if (!e || !e.id) continue;
      if (sync.entries[e.id] || st.deletedEntries[e.id]) continue;
      rows.push({ user_id: userId, id: e.id, date: dateKey, t: Number(e.t) || 0,
                  ml: Number(e.ml) || 0, deleted: false });
    }
  }
  // --- 消した記録（墓標をまだ送っていないものだけ） ---
  for (const [id, info] of Object.entries(st.deletedEntries || {})) {
    if (sync.tombs[id]) continue;
    rows.push({ user_id: userId, id, date: (info && info.d) || '', t: 0, ml: 0, deleted: true });
  }
  if (rows.length) {
    await _restUpsert('uruoi_entries?on_conflict=user_id,id', rows);
    for (const r of rows) {
      if (r.deleted) { sync.tombs[r.id] = 1; delete sync.entries[r.id]; }
      else sync.entries[r.id] = 1;
    }
  }

  // --- 日ごとの目標（変わった日だけ） ---
  const dayRows = [];
  for (const [dateKey, rec] of Object.entries(st.daily || {})) {
    const target = rec ? (rec.targetMl ?? null) : null;
    const h = _hash(String(target));
    if (sync.days[dateKey] === h) continue;
    dayRows.push({ user_id: userId, date: dateKey, target_ml: target });
  }
  if (dayRows.length) {
    await _restUpsert('uruoi_days?on_conflict=user_id,date', dayRows);
    for (const r of dayRows) sync.days[r.date] = _hash(String(r.target_ml));
  }

  // --- 設定・水知識 ---
  // 項目ごとにハッシュを見て、変わった項目だけ「いつ変えたか」を進める。
  // 相手の端末はこの時刻を見て、どちらを採るか決める。
  const fields = {
    profile:      st.profile,
    quickAdds:    st.quickAdds,
    settings:     st.settings,
    knowledge:    st.knowledge,
    activeSeries: (st.knowledge || {}).activeSeries,
  };
  let docChanged = false;
  for (const [name, value] of Object.entries(fields)) {
    const h = _hash(JSON.stringify(value ?? null));
    if (sync.docHash[name] === h) continue;
    sync.docHash[name] = h;
    sync.rev[name] = now;
    docChanged = true;
  }
  if (docChanged) {
    await _rest('uruoi_state?on_conflict=user_id', {
      method: 'POST',
      body: [{
        user_id: userId,
        doc: {
          profile: st.profile,
          quickAdds: st.quickAdds,
          settings: st.settings,
          knowledge: st.knowledge,
          rev: sync.rev,
        },
      }],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}

// ========== 同期のきっかけ ==========
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(300);
});

// ========== 画面 ==========
const $s = id => document.getElementById(id);

function updateSyncUI() {
  const box = $s('sync-status');
  if (!box) return;
  const s = sbLoadSession();
  const show = (id, on) => { const el = $s(id); if (el) el.classList.toggle('hidden', !on); };

  show('sync-login-btn', !s);
  show('sync-logout-btn', !!s);
  show('sync-now-btn', !!s);

  const rb = rollbackInfo();
  show('sync-rollback-btn', !!(s && rb));
  if (rb && $s('sync-rollback-btn')) {
    $s('sync-rollback-btn').textContent = `取り込み前（記録${rb.count}件）に戻す`;
  }

  box.className = 'hint syncStatus';
  if (!s) { box.textContent = 'ログインしていません（この端末だけに保存されます）'; return; }
  if (_syncing) { box.textContent = '同期中…'; return; }
  if (_lastSyncError) {
    box.textContent = `${s.email}／同期できていません（${_lastSyncError}）`;
    box.className = 'hint syncStatus error';
    return;
  }
  const t = _loadSyncState().lastSyncedAt;
  box.textContent = `${s.email}／最終同期 ${t ? new Date(t).toLocaleString('ja-JP') : 'まだ'}`;
  box.className = 'hint syncStatus ok';
}

function openSyncLogin() {
  $s('sync-email').value = (sbLoadSession() || {}).email || '';
  $s('sync-password').value = '';
  $s('sync-login-msg').textContent = '';
  $s('syncLoginOverlay').classList.add('open');
}

async function submitSyncLogin(mode) {
  const email = $s('sync-email').value.trim();
  const password = $s('sync-password').value;
  const msg = $s('sync-login-msg');
  if (!email || !password) { msg.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (mode === 'signup' && password.length < 8) {
    msg.textContent = 'パスワードは8文字以上にしてください'; return;
  }
  msg.textContent = mode === 'signup' ? '登録中…' : 'ログイン中…';
  try {
    if (mode === 'signup') {
      const r = await sbSignUp(email, password);
      if (r.needsConfirmation) {
        msg.textContent = '確認メールを送りました。リンクを開いてから「ログイン」してください。';
        return;
      }
    } else {
      await sbSignIn(email, password);
    }
    $s('syncLoginOverlay').classList.remove('open');
    updateSyncUI();
    await syncNow({ toast: true });
  } catch (e) {
    msg.textContent = 'できませんでした：' + (e.message || e);
  }
}

window.addEventListener('load', () => {
  const on = (id, fn) => { const el = $s(id); if (el) el.onclick = fn; };
  on('sync-login-btn', openSyncLogin);
  on('closeSyncLogin', () => $s('syncLoginOverlay').classList.remove('open'));
  on('sync-do-login', () => submitSyncLogin('login'));
  on('sync-do-signup', () => submitSyncLogin('signup'));
  on('sync-now-btn', () => syncNow({ toast: true }));
  on('sync-rollback-btn', restoreRollback);
  on('sync-logout-btn', () => {
    if (!confirm('ログアウトします。この端末の記録はそのまま残ります。よろしいですか？')) return;
    sbSignOut();
    updateSyncUI();
    alert('ログアウトしました');
  });

  updateSyncUI();
  scheduleSync(1200);
});
