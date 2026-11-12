/* Hadi Reels server part: every action that moves coins, diamonds or money runs here, never in the browser.
   Same rules as the earlier SQL version (schema3_money.sql). */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const now = () => new Date().toISOString();
const METHODS = ['easypaisa', 'jazzcash', 'bank'];
const DEF_MONEY = { coin_price: 4, diamond_value: 2, min_withdraw: 500, packs: [5, 50, 100, 500, 1000], gift_bonus_pct: 1 };
/* creator gets the gift coins plus this % extra as diamonds (default 1%). Change gift_bonus_pct in app_settings/money. */
const dia = (coins, m) => Math.round(coins * (100 + (typeof m.gift_bonus_pct === 'number' ? m.gift_bonus_pct : 1)) / 100);
const DEF_GIFTS = { rose: ['Rose', 1], heart: ['Finger heart', 5], donut: ['Doughnut', 30], crown: ['Crown', 99], rocket: ['Rocket', 500] };
const fail = (m) => { throw new HttpsError('failed-precondition', m); };
const rk = (r) => (r === 'ceo' ? 2 : r === 'admin' ? 1 : 0);

async function who(tx, req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Log in first');
  const p = await tx.get(db.doc('profiles/' + req.auth.uid));
  if (!p.exists || p.data().banned) fail('Not allowed');
  return { id: req.auth.uid, ...p.data() };
}
const money = async (tx) => { const s = await tx.get(db.doc('app_settings/money')); return s.exists ? s.data().value : DEF_MONEY; };
const addTx = (tx, uid, amt, note, unit) => tx.set(db.collection('txs').doc(), { user_id: uid, amt, note, unit, created_at: now() });
const wallet = async (tx, uid) => { const w = await tx.get(db.doc('wallets/' + uid)); return w.exists ? w.data() : { user_id: uid, coins: 0, diamonds: 0 }; };
const setWallet = (tx, uid, w) => tx.set(db.doc('wallets/' + uid), { user_id: uid, coins: w.coins, diamonds: w.diamonds || 0, created_at: w.created_at || now() });
const wrap = (fn) => onCall({ region: 'us-central1', maxInstances: 5 }, async (req) => {
  try { const r = await db.runTransaction((tx) => fn(tx, req, req.data || {})); return Object.assign({ ok: true }, r || {}); }
  catch (e) { if (e instanceof HttpsError) throw e; console.error(e); throw new HttpsError('internal', 'Server error'); }
});

/* a viewer sends a gift on a video */
exports.send_gift = wrap(async (tx, req, a) => {
  const me = await who(tx, req);
  const gs = await tx.get(db.doc('gifts/' + a.gid));
  const g = gs.exists ? gs.data() : DEF_GIFTS[a.gid] && { name: DEF_GIFTS[a.gid][0], emoji: '\u{1F381}', coins: DEF_GIFTS[a.gid][1] };
  if (!g) fail('Not allowed');
  const ps = await tx.get(db.doc('posts/' + a.pid));
  if (!ps.exists) fail('Not allowed');
  const post = ps.data(), to = post.user_id;
  if (to === me.id) fail('Not allowed');
  const [b1, b2, fol, owner] = await Promise.all([tx.get(db.doc('blocks/' + to + '_' + me.id)), tx.get(db.doc('blocks/' + me.id + '_' + to)),
    tx.get(db.doc('follows/' + me.id + '_' + to)), tx.get(db.doc('profiles/' + to))]);
  if (b1.exists || b2.exists || !owner.exists || owner.data().banned) fail('Not allowed');
  if (post.priv && !fol.exists) fail('Not allowed');
  const mw = await wallet(tx, me.id), tw = await wallet(tx, to), mn = await money(tx), d = dia(g.coins, mn);
  if (mw.coins < g.coins) fail('Not enough coins');
  setWallet(tx, me.id, { ...mw, coins: mw.coins - g.coins });
  setWallet(tx, to, { ...tw, diamonds: (tw.diamonds || 0) + d });
  addTx(tx, me.id, -g.coins, 'Sent ' + g.name + ' to @' + owner.data().username, 'coins');
  addTx(tx, to, d, g.name + ' from @' + me.username, 'diamonds');
  tx.set(db.collection('events').doc(), { type: 'gift', from_id: me.id, to_id: to, post_id: a.pid, text: (g.emoji || '') + ' ' + g.name, created_at: now() });
});

/* the user says "I paid, here is my transaction ID" */
exports.request_topup = wrap(async (tx, req, a) => {
  const me = await who(tx, req), m = await money(tx), ref = String(a.p_ref || '').trim().toLowerCase();
  if (!METHODS.includes(a.p_method)) fail('Choose a payment method');
  if (!(m.packs || []).includes(a.p_coins)) fail('Choose a coin pack');
  if (ref.length < 6 || ref.length > 40) fail('Enter the transaction ID from your receipt');
  const slip = String(a.p_slip || '');
  if (!slip.startsWith('slips/' + me.id + '/') || slip.length > 120 || slip.includes('..')) fail('Attach a photo of your payment slip');
  const key = db.doc('topup_refs/' + a.p_method + '_' + ref.replace(/[^a-z0-9]/g, '_'));
  const used = await tx.get(key);
  if (used.exists) fail('That transaction ID was already used');
  const pend = await tx.get(db.collection('topups').where('user_id', '==', me.id).where('status', '==', 'pending'));
  if (pend.size >= 5) fail('You already have 5 pending requests');
  const id = db.collection('topups').doc();
  tx.set(key, { topup: id.id, user_id: me.id });
  tx.set(id, { id: id.id, user_id: me.id, coins: a.p_coins, amount: Math.ceil(a.p_coins * m.coin_price), method: a.p_method, ref, sender: String(a.p_sender || '').trim().slice(0, 40), slip, status: 'pending', created_at: now(), decided_at: null });
});

/* CEO only: payment checked in the CEO's own bank app */
exports.decide_topup = wrap(async (tx, req, a) => {
  const me = await who(tx, req); if (me.role !== 'ceo') fail('Only the CEO can do this');
  const r = db.doc('topups/' + a.p_id), t = await tx.get(r);
  if (!t.exists || t.data().status !== 'pending') fail('Request not found or already handled');
  const d = t.data();
  if (a.p_ok) {
    const w = await wallet(tx, d.user_id);
    setWallet(tx, d.user_id, { ...w, coins: w.coins + d.coins });
    addTx(tx, d.user_id, d.coins, 'Recharge (' + d.coins + ' coins)', 'coins');
  }
  tx.update(r, { status: a.p_ok ? 'approved' : 'rejected', decided_at: now() });
});

exports.request_withdrawal = wrap(async (tx, req, a) => {
  const me = await who(tx, req), m = await money(tx), d = Math.floor(Number(a.p_d));
  if (!METHODS.includes(a.p_method)) fail('Choose where to receive the money');
  if (!(d >= m.min_withdraw)) fail('Minimum withdrawal is ' + m.min_withdraw + ' diamonds');
  if (String(a.p_account || '').trim().length < 6 || String(a.p_aname || '').trim().length < 2) fail('Enter your account number and name');
  const pend = await tx.get(db.collection('withdrawals').where('user_id', '==', me.id).where('status', '==', 'pending'));
  if (!pend.empty) fail('You already have a pending withdrawal');
  const w = await wallet(tx, me.id);
  if ((w.diamonds || 0) < d) fail('Not enough diamonds');
  setWallet(tx, me.id, { ...w, diamonds: w.diamonds - d });
  const id = db.collection('withdrawals').doc();
  tx.set(id, { id: id.id, user_id: me.id, diamonds: d, amount: Math.floor(d * m.diamond_value), method: a.p_method, account: String(a.p_account).trim().slice(0, 40), aname: String(a.p_aname).trim().slice(0, 40), status: 'pending', created_at: now(), decided_at: null });
  addTx(tx, me.id, -d, 'Withdrawal request', 'diamonds');
});

exports.decide_withdrawal = wrap(async (tx, req, a) => {
  const me = await who(tx, req); if (me.role !== 'ceo') fail('Only the CEO can do this');
  const r = db.doc('withdrawals/' + a.p_id), s = await tx.get(r);
  if (!s.exists || s.data().status !== 'pending') fail('Request not found or already handled');
  const d = s.data();
  if (a.p_paid) tx.update(r, { status: 'paid', decided_at: now() });
  else {
    const w = await wallet(tx, d.user_id);
    setWallet(tx, d.user_id, { ...w, diamonds: (w.diamonds || 0) + d.diamonds });
    addTx(tx, d.user_id, d.diamonds, 'Withdrawal returned', 'diamonds');
    tx.update(r, { status: 'rejected', decided_at: now() });
  }
});

exports.admin_grant = wrap(async (tx, req, a) => {
  const me = await who(tx, req), n = Math.floor(Number(a.p_n));
  if (me.role !== 'ceo' || !(n >= 1 && n <= 100000)) fail('Only the CEO can do this');
  const t = await tx.get(db.doc('profiles/' + a.p_target)); if (!t.exists) fail('User not found');
  const w = await wallet(tx, a.p_target);
  setWallet(tx, a.p_target, { ...w, coins: w.coins + n });
  addTx(tx, a.p_target, n, 'Coins added by the app owner', 'coins');
});

exports.boost_post = wrap(async (tx, req, a) => {
  const me = await who(tx, req), d = Number(a.d);
  if (![1, 3, 7].includes(d)) fail('Not allowed');
  const r = db.doc('posts/' + a.pid), p = await tx.get(r);
  if (!p.exists || p.data().user_id !== me.id || p.data().priv) fail('Not allowed');
  const w = await wallet(tx, me.id), cost = d * 10;
  if (w.coins < cost) fail('Not enough coins');
  setWallet(tx, me.id, { ...w, coins: w.coins - cost });
  const base = Math.max(Date.now(), p.data().boost ? Date.parse(p.data().boost) : 0);
  tx.update(r, { boost: new Date(base + d * 864e5).toISOString() });
  addTx(tx, me.id, -cost, 'Promote video (' + d + ' day' + (d > 1 ? 's' : '') + ')', 'coins');
});

/* a viewer sends a gift to the host or a guest inside a LIVE room */
exports.live_gift = wrap(async (tx, req, a) => {
  const me = await who(tx, req);
  const gs = await tx.get(db.doc('gifts/' + a.gid));
  const g = gs.exists ? gs.data() : DEF_GIFTS[a.gid] && { name: DEF_GIFTS[a.gid][0], coins: DEF_GIFTS[a.gid][1] };
  if (!g || !a.to || a.to === me.id) fail('Not allowed');
  const [b1, b2, owner] = await Promise.all([tx.get(db.doc('blocks/' + a.to + '_' + me.id)), tx.get(db.doc('blocks/' + me.id + '_' + a.to)), tx.get(db.doc('profiles/' + a.to))]);
  if (b1.exists || b2.exists || !owner.exists || owner.data().banned) fail('Not allowed');
  const mw = await wallet(tx, me.id), tw = await wallet(tx, a.to), mn = await money(tx), d = dia(g.coins, mn);
  if (mw.coins < g.coins) fail('Not enough coins');
  setWallet(tx, me.id, { ...mw, coins: mw.coins - g.coins });
  setWallet(tx, a.to, { ...tw, diamonds: (tw.diamonds || 0) + d });
  addTx(tx, me.id, -g.coins, 'Sent ' + g.name + ' in LIVE to @' + owner.data().username, 'coins');
  addTx(tx, a.to, d, g.name + ' from @' + me.username + ' (LIVE)', 'diamonds');
});


/* ---------- LIVE abuse: warnings, LIVE ban, account ban, appeals ---------- */
const BAD_WORDS=["fuck", "shit", "bitch", "bastard", "asshole", "dick", "pussy", "slut", "whore", "cunt", "nigger", "faggot", "retard", "bhenchod", "behenchod", "madarchod", "chutiya", "gandu", "gaand", "lund", "loda", "lora", "harami", "haramzada", "haramzadi", "kutta", "kutti", "kamina", "kamini", "randi", "bhosdi", "bhosdike", "bhosda", "bc", "mc"];
const _collapse=s=>s.replace(/(.)\1+/g,'$1');
const _norm=t=>_collapse(String(t||'').toLowerCase().replace(/[01345@$]/g,c=>({'0':'o','1':'i','3':'e','4':'a','5':'s','@':'a','$':'s'}[c])).replace(/[^a-z\s]/g,' '));
const _bw=BAD_WORDS.map(_collapse),_short=new Set(_bw.filter(w=>w.length<=4)),_long=_bw.filter(w=>w.length>4);
const isBad=t=>_norm(t).split(/\s+/).filter(Boolean).some(k=>_short.has(k)||_long.some(w=>k.includes(w)));

const DAY = 864e5;

/* the app reports the user's own blocked abusive message. The server checks the words again, so nobody can be framed. */
exports.live_strike = wrap(async (tx, req, a) => {
  const me = await who(tx, req);
  if (!isBad(a.text)) fail('No rule was broken');
  const ref = db.doc('strikes/' + me.id), s = await tx.get(ref);
  const old = s.exists ? s.data() : { count: 0, total: 0, reasons: [] };
  const fresh = old.last_at && Date.now() - Date.parse(old.last_at) > DAY;
  const count = (fresh ? 0 : old.count || 0) + 1, total = (old.total || 0) + 1;
  let level = 'warn', until = old.live_ban_until || null;
  if (count >= 3) { level = 'liveban'; until = new Date(Date.now() + DAY).toISOString(); }
  if (total >= 8 && me.role === 'user') level = 'ban';
  const reasons = [...(old.reasons || []), { text: String(a.text).slice(0, 60), at: now() }].slice(-5);
  tx.set(ref, { user_id: me.id, count, total, last_at: now(), live_ban_until: until, reasons });
  if (level === 'ban') tx.update(db.doc('profiles/' + me.id), { banned: true, ban_reason: 'Repeated abusive language in LIVE' });
  return { level, count, until };
});

/* a banned person writes an appeal (works even though the account is banned) */
exports.submit_appeal = onCall({ region: 'us-central1', maxInstances: 5 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Log in first');
  const text = String((req.data || {}).p_text || '').trim();
  if (text.length < 20 || text.length > 500) throw new HttpsError('failed-precondition', 'Write 20 to 500 characters');
  const p = await db.doc('profiles/' + req.auth.uid).get();
  if (!p.exists || !p.data().banned) throw new HttpsError('failed-precondition', 'Your account is not banned');
  const pend = await db.collection('appeals').where('user_id', '==', req.auth.uid).where('status', '==', 'pending').get();
  if (!pend.empty) throw new HttpsError('failed-precondition', 'You already have an appeal waiting');
  const id = db.collection('appeals').doc();
  await id.set({ id: id.id, user_id: req.auth.uid, username: p.data().username, text, status: 'pending', created_at: now(), decided_at: null });
  return { ok: true };
});

/* admin or CEO: accept (unban + clear strikes) or reject an appeal */
exports.decide_appeal = wrap(async (tx, req, a) => {
  const me = await who(tx, req); if (rk(me.role) < 1) fail('Only staff can do this');
  const r = db.doc('appeals/' + a.p_id), s = await tx.get(r);
  if (!s.exists || s.data().status !== 'pending') fail('Appeal not found or already handled');
  const tp = await tx.get(db.doc('profiles/' + s.data().user_id));
  if (tp.exists && rk(tp.data().role) >= rk(me.role)) fail('Not allowed');
  if (a.p_ok && tp.exists) {
    tx.update(tp.ref, { banned: false, ban_reason: admin.firestore.FieldValue.delete() });
    tx.set(db.doc('strikes/' + s.data().user_id), { user_id: s.data().user_id, count: 0, total: 0, last_at: null, live_ban_until: null, reasons: [] });
  }
  tx.update(r, { status: a.p_ok ? 'approved' : 'rejected', decided_at: now(), decided_by: me.id });
});


/* ===== push notifications: phone alerts for likes, comments, follows, gifts and messages ===== */
async function pushTo(uid, title, body) {
  const ref = db.doc('push_tokens/' + uid);
  const d = await ref.get();
  const tokens = d.exists ? (d.data().tokens || []) : [];
  if (!tokens.length) return;
  const r = await admin.messaging().sendEachForMulticast({ tokens, data: { title, body, url: '/' }, webpush: { headers: { Urgency: 'high' } } });
  const dead = [];
  r.responses.forEach((x, i) => {
    const c = (x.error && x.error.code) || '';
    if (!x.success && (c.includes('registration-token-not-registered') || c.includes('invalid-argument') || c.includes('invalid-registration-token'))) dead.push(tokens[i]);
  });
  if (dead.length) await ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) });
}
const nameOf = async (uid) => { const p = await db.doc('profiles/' + uid).get(); return p.exists ? '@' + (p.data().username || 'someone') : 'Someone'; };
const EV = { like: 'liked your video', comment: 'commented on your video', follow: 'started following you', mention: 'mentioned you', gift: 'sent you a gift', request: 'wants to follow you' };

exports.push_event = onDocumentCreated({ document: 'events/{id}', region: 'us-central1', maxInstances: 5 }, async (ev) => {
  try {
    const e = ev.data && ev.data.data(); if (!e || !e.to_id || e.to_id === e.from_id || !EV[e.type]) return;
    const who = await nameOf(e.from_id);
    const extra = e.type === 'comment' && e.text ? ': ' + String(e.text).slice(0, 80) : '';
    await pushTo(e.to_id, 'Hadi Reels', who + ' ' + EV[e.type] + extra);
  } catch (err) { console.error('push_event', err); }
});

exports.push_msg = onDocumentCreated({ document: 'msgs/{id}', region: 'us-central1', maxInstances: 5 }, async (ev) => {
  try {
    const m = ev.data && ev.data.data(); if (!m || !m.to_id || m.to_id === m.from_id) return;
    await pushTo(m.to_id, await nameOf(m.from_id), String(m.text || '').slice(0, 100));
  } catch (err) { console.error('push_msg', err); }
});
