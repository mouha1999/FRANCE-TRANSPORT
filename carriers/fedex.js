const base = () => process.env.FEDEX_BASE || 'https://apis.fedex.com';
let tok = { v: null, exp: 0 };

async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch(base() + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials',
      client_id: process.env.FEDEX_CLIENT_ID, client_secret: process.env.FEDEX_CLIENT_SECRET })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('FedEx auth ' + r.status);
  tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 };
  return tok.v;
}

exports.name = 'FedEx';

// NB : l'API Rate ne couvre PAS FedEx Freight (LTL) : API séparée.
exports.rate = async ({ from, to, parcels }) => {
  const a = x => ({ address: { postalCode: x.postal, countryCode: x.country } });
  const body = {
    accountNumber: { value: process.env.FEDEX_ACCOUNT },
    requestedShipment: {
      shipper: a(from), recipient: a(to),
      pickupType: 'USE_SCHEDULED_PICKUP',
      rateRequestType: ['ACCOUNT'],
      requestedPackageLineItems: parcels.map(p => ({
        weight: { units: 'KG', value: p.weight },
        dimensions: { length: p.length, width: p.width, height: p.height, units: 'CM' }
      }))
    }
  };
  const r = await fetch(base() + '/rate/v1/rates/quotes', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', 'X-locale': 'fr_FR' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('FedEx rate ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return (j.output?.rateReplyDetails || []).map(d => {
    const rd = d.ratedShipmentDetails?.find(x => x.rateType === 'ACCOUNT') || d.ratedShipmentDetails?.[0];
    return { carrier: 'FedEx', service: d.serviceType, cost: Number(rd?.totalNetCharge),
             negotiated: rd?.rateType === 'ACCOUNT', days: null };
  });
};

// À implémenter : Ship API (étiquette) + Pickup Request API
exports.book = async () => { throw new Error('FedEx book() non implémenté'); };
