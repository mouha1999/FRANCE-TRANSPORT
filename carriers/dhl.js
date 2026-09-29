const base = () => process.env.DHL_BASE || 'https://express.api.dhl.com/mydhlapi';

exports.name = 'DHL';

// GET /rates = 1 seul colis. Multi-colis : POST /rates (à ajouter).
exports.rate = async ({ from, to, parcels }) => {
  if (parcels.length !== 1) throw new Error('DHL : multi-colis non géré pour le moment');
  const p = parcels[0];
  const d = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const qs = new URLSearchParams({
    accountNumber: process.env.DHL_ACCOUNT,
    originCountryCode: from.country, originCityName: from.city, originPostalCode: from.postal,
    destinationCountryCode: to.country, destinationCityName: to.city, destinationPostalCode: to.postal,
    weight: String(p.weight), length: String(p.length), width: String(p.width), height: String(p.height),
    plannedShippingDate: d, isCustomsDeclarable: 'false', unitOfMeasurement: 'metric'
  });
  const r = await fetch(`${base()}/rates?${qs}`, { headers: {
    Authorization: 'Basic ' + Buffer.from(`${process.env.DHL_USER}:${process.env.DHL_PASSWORD}`).toString('base64'),
    'x-version': process.env.DHL_API_VERSION || '3.3.1' } });
  const j = await r.json();
  if (!r.ok) throw new Error('DHL rate ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return (j.products || []).map(pr => {
    const tp = (pr.totalPrice || []).find(x => x.currencyType === 'BILLC') || (pr.totalPrice || [])[0];
    return { carrier: 'DHL', service: pr.productName, productCode: pr.productCode, cost: Number(tp?.price), negotiated: true,
             days: Number(pr.deliveryCapabilities?.totalTransitDays) || null };
  });
};

const hdr = () => ({
  Authorization: 'Basic ' + Buffer.from(`${process.env.DHL_USER}:${process.env.DHL_PASSWORD}`).toString('base64'),
  'x-version': process.env.DHL_API_VERSION || '3.3.1', 'Content-Type': 'application/json' });

// Décalage horaire de Paris à la date voulue, ex. "GMT+02:00"
const parisOffset = d => new Intl.DateTimeFormat('en', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' })
  .formatToParts(d).find(x => x.type === 'timeZoneName')?.value || 'GMT+01:00';

// Jour d'enlèvement : au plus tôt demain, jamais le week-end
function pickupDay(s) {
  const min = new Date(Date.now() + 86400000);
  let d = /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T12:00:00Z') : min;
  if (d < min) d = min;
  while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() + 86400000);
  return d.toISOString().slice(0, 10);
}

// Crée l'expédition + l'étiquette + demande l'enlèvement en un seul appel (POST /shipments, pickup.isRequested).
// Schéma à valider en SANDBOX avec votre compte (champs obligatoires variables selon pays/produit).
exports.book = async ({ quote: q, contact, fromAddress, toAddress, pickupDate, recipient }) => {
  const day = pickupDay(pickupDate);
  const ready = process.env.PICKUP_READY || '09:00', close = process.env.PICKUP_CLOSE || '18:00';
  const party = (a, line, name, phone) => ({
    postalAddress: { postalCode: a.postal, cityName: a.city, countryCode: a.country,
                     addressLine1: line.slice(0, 45), addressLine2: line.slice(45, 90) || undefined },
    contactInformation: { companyName: name.slice(0, 35), fullName: name.slice(0, 35), phone } });
  const body = {
    plannedShippingDateAndTime: `${day}T${ready}:00 ${parisOffset(new Date(day + 'T12:00:00Z'))}`,
    productCode: q.internal.productCode,
    accounts: [{ typeCode: 'shipper', number: process.env.DHL_ACCOUNT }],
    customerDetails: {
      shipperDetails: party(q.from, fromAddress, contact.name, contact.phone),
      receiverDetails: party(q.to, toAddress, recipient.name, recipient.phone) },   // pas d'email : DHL n'écrit pas au client
    content: {
      packages: q.parcels.map(p => ({ weight: p.weight, dimensions: { length: p.length, width: p.width, height: p.height } })),
      isCustomsDeclarable: false, description: 'Marchandise', unitOfMeasurement: 'metric' },
    customerReferences: [{ typeCode: 'CU', value: q.ref }],
    pickup: { isRequested: true, closeTime: close, location: 'reception' }
  };
  const r = await fetch(base() + '/shipments', { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('DHL shipment ' + r.status + ' ' + JSON.stringify(j).slice(0, 400));
  const label = (j.documents || []).find(d => d.typeCode === 'label') || (j.documents || [])[0];
  const conf = (j.dispatchConfirmationNumbers || [])[0];
  return { tracking: j.shipmentTrackingNumber, labelPdf: label?.content,
           pickup: { date: day, window: `${ready}-${close}`, confirmed: !!conf, confirmation: conf } };
};
