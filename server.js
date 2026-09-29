require('dotenv').config();
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { sendMail } = require('./mail');
const carriers = [require('./carriers/ups'), require('./carriers/fedex'), require('./carriers/dhl')];

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB = path.join(__dirname, 'data.json');
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { quotes: {} };
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const N = (k, d) => Number(process.env[k] || d);
const r2 = x => Math.round(x * 100) / 100;

// Prix client à partir du coût transporteur
const MARGIN = N('MARGIN', 0.5), TVA = N('TVA', 0.2);
const sell = cost => r2(process.env.MARGIN_MODE === 'margin' ? cost / (1 - MARGIN) : cost * (1 + MARGIN));

// --- Validation ---
const okAddr = a => a && typeof a.postal === 'string' && typeof a.city === 'string' && /^[A-Z]{2}$/.test(a.country || '');
const okParcel = p => p && ['length', 'width', 'height', 'weight'].every(k => Number(p[k]) > 0 && Number(p[k]) < 1000);
const norm = p => ({ length: Math.ceil(p.length), width: Math.ceil(p.width), height: Math.ceil(p.height),
                     weight: Math.ceil(p.weight * 10) / 10 });

// Hors gabarit colis (armoire, meuble...) => devis affrètement/palette (API Freight séparées)
function oversize(parcels) {
  const W = N('MAX_WEIGHT', 68), L = N('MAX_LENGTH', 240), G = N('MAX_L_PLUS_GIRTH', 330);
  return parcels.some(p => {
    const s = [p.length, p.width, p.height].sort((a, b) => b - a);
    return p.weight > W || s[0] > L || s[0] + 2 * (s[1] + s[2]) > G;
  });
}
const parcelTxt = ps => ps.map((p, i) => `  Colis ${i + 1}: ${p.length}x${p.width}x${p.height} cm, ${p.weight} kg`).join('\n');
const notify = (subject, text, att) => sendMail(process.env.EXPLOITANT_EMAIL, subject, text, att).catch(e => console.error('mail:', e.message));

// --- 1. Devis automatique (le client ne voit JAMAIS le transporteur) ---
app.post('/api/quote', async (req, res) => {
  const { from, to } = req.body || {};
  const parcels = Array.isArray(req.body?.parcels) ? req.body.parcels : [];
  if (!okAddr(from) || !okAddr(to) || !parcels.length || parcels.length > 10 || !parcels.every(okParcel))
    return res.status(400).json({ error: 'Données invalides' });
  const ps = parcels.map(norm), id = crypto.randomBytes(6).toString('hex');
  const route = `${from.city} (${from.postal}) → ${to.city} (${to.postal})`;

  const manual = why => {
    db.quotes[id] = { id, status: 'manual', why, from, to, parcels: ps, created: Date.now() }; save();
    notify(`[Devis manuel] ${route}`, `${why}\n\nTrajet : ${route}\n${parcelTxt(ps)}\nRéf : ${id}`);
    return res.json({ id, manual: true, message: 'Votre envoi nécessite un devis sur mesure. Nous revenons vers vous rapidement.' });
  };
  if (oversize(ps)) return manual('Hors gabarit colis express : devis palette / messagerie / affrètement à faire.');

  const settled = await Promise.allSettled(carriers.map(c => c.rate({ from, to, parcels: ps })));
  settled.forEach((s, i) => s.status === 'rejected' && console.error(carriers[i].name, s.reason.message));
  const offers = settled.flatMap(s => s.status === 'fulfilled' ? s.value : []).filter(o => o.cost > 0);
  if (!offers.length) return manual('Aucun tarif transporteur disponible automatiquement.');

  const best = offers.reduce((a, b) => (b.cost < a.cost ? b : a));
  const ht = sell(best.cost);
  db.quotes[id] = { id, status: 'quoted', from, to, parcels: ps, created: Date.now(),
    internal: { carrier: best.carrier, service: best.service, productCode: best.productCode, cost: best.cost, negotiated: best.negotiated, offers },
    priceHT: ht };
  save();
  notify(`[Devis] ${route} - ${ht} € HT`,
    `Nouvelle cotation.\nTrajet : ${route}\n${parcelTxt(ps)}\nRetenu : ${best.carrier} ${best.service} - coût ${best.cost} €${best.negotiated ? '' : ' (TARIF PUBLIC, compte non appliqué ?)'}\nRéf : ${id}`);
  res.json({ id, priceHT: ht, tva: r2(ht * TVA), priceTTC: r2(ht * (1 + TVA)), days: best.days });
});

// --- 2. Acceptation : réservation + enlèvement ---
app.post('/api/quote/:id/accept', async (req, res) => {
  const q = db.quotes[req.params.id];
  if (!q || q.status !== 'quoted') return res.status(404).json({ error: 'Devis introuvable ou déjà traité' });
  const { contact, fromAddress, toAddress, pickupDate, recipient } = req.body || {};
  if (!contact?.name || !/^\S+@\S+\.\S+$/.test(contact.email || '') || !contact.phone || !fromAddress || !toAddress || !recipient?.name || !recipient?.phone)
    return res.status(400).json({ error: 'Coordonnées incomplètes' });

  q.ref = 'TP-' + q.id.toUpperCase();
  const c = carriers.find(x => x.name === q.internal.carrier);
  let booking = null, note = '';
  try { booking = await c.book({ quote: q, contact, fromAddress, toAddress, pickupDate, recipient }); }
  catch (e) { note = 'RÉSERVATION TRANSPORTEUR À FAIRE MANUELLEMENT (' + e.message + ')'; }

  q.status = 'accepted'; q.ref = 'TP-' + q.id.toUpperCase(); q.contact = contact; q.fromAddress = fromAddress; q.toAddress = toAddress;
  q.pickup = booking?.pickup || { date: pickupDate || 'à confirmer', window: '09:00-18:00', confirmed: !!booking };
  let attachments;
  if (booking?.labelPdf) {   // étiquette enregistrée + envoyée à l'exploitant uniquement
    fs.mkdirSync(path.join(__dirname, 'labels'), { recursive: true });
    const buf = Buffer.from(booking.labelPdf, 'base64');
    fs.writeFileSync(path.join(__dirname, 'labels', q.ref + '.pdf'), buf);
    attachments = [{ filename: q.ref + '.pdf', content: buf }];
    delete booking.labelPdf;
  }
  if (booking && !booking.pickup.confirmed) note = 'ENLÈVEMENT NON CONFIRMÉ PAR LE TRANSPORTEUR : à vérifier.';
  q.booking = booking; save();

  notify(`[À ENLEVER] ${q.ref} - ${q.from.city} → ${q.to.city}`,
    `${note}\n\nTransporteur : ${q.internal.carrier} ${q.internal.service} (coût ${q.internal.cost} €)\nEnlèvement : ${q.pickup.date} ${q.pickup.window}\n` +
    `Départ : ${fromAddress}\nArrivée : ${toAddress}\nContact : ${contact.name} - ${contact.phone} - ${contact.email}\nSuivi transporteur : ${booking?.tracking || '-'}\n${parcelTxt(q.parcels)}`, attachments);
  // Mail client NEUTRE : aucun nom de transporteur
  sendMail(contact.email, `Votre envoi ${q.ref} est confirmé`,
    `Bonjour ${contact.name},\n\nVotre envoi ${q.from.city} → ${q.to.city} est confirmé.\nRéférence : ${q.ref}\n` +
    `Enlèvement : ${q.pickup.date}, entre ${q.pickup.window}\nMontant : ${q.priceHT} € HT\n\nCordialement,\nTransitPro`).catch(e => console.error('mail:', e.message));
  res.json({ ref: q.ref, pickup: q.pickup });
});

// --- 3. Suivi neutre ---
app.get('/api/track/:ref', (req, res) => {
  const q = Object.values(db.quotes).find(x => x.ref === req.params.ref);
  if (!q) return res.status(404).json({ error: 'Introuvable' });
  res.json({ ref: q.ref, status: q.tracking?.status || 'Enlèvement prévu', pickup: q.pickup });
});

// --- 4. Estimation des dimensions depuis la photo (à confirmer par le client) ---
app.post('/api/estimate', async (req, res) => {
  try {
    const { image, mediaType } = req.body || {};
    if (!image || !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Estimation indisponible' });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 400, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
        { type: 'text', text: 'Estime les dimensions (cm) et le poids (kg) de cet objet une fois emballé pour expédition. Réponds UNIQUEMENT en JSON : {"length":n,"width":n,"height":n,"weight":n,"description":"..."}' }] }] })
    });
    const j = await r.json();
    const m = (j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { error: 'Estimation impossible' });
  } catch (e) { res.status(500).json({ error: 'Estimation impossible' }); }
});

// --- 5. Admin (vous seul) : coûts, transporteurs, marge ---
app.get('/api/admin/quotes', (req, res) => {
  const t = process.env.ADMIN_TOKEN || '';
  const given = Buffer.from(String(req.get('x-admin-token') || ''));
  const want = Buffer.from(t);
  if (!t || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(Object.values(db.quotes).map(q => ({ ...q, marge: q.internal ? r2(q.priceHT - q.internal.cost) : null })));
});

app.listen(N('PORT', 3000), () => console.log('TransitPro sur :' + N('PORT', 3000)));
