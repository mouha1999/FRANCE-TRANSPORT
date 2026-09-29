const crypto = require('crypto');
const base = () => process.env.UPS_BASE || 'https://onlinetools.ups.com';
let tok = { v: null, exp: 0 };

async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const basic = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(base() + '/security/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + basic },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json();
  if (!r.ok) throw new Error('UPS auth ' + r.status);
  tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 };
  return tok.v;
}

exports.name = 'UPS';

exports.rate = async ({ from, to, parcels }) => {
  const addr = a => ({ City: a.city, PostalCode: a.postal, CountryCode: a.country });
  const body = { RateRequest: {
    Request: { RequestOption: 'Shop' },
    Shipment: {
      Shipper: { Name: 'TransitPro', ShipperNumber: process.env.UPS_ACCOUNT, Address: addr(from) },
      ShipFrom: { Name: 'Expediteur', Address: addr(from) },
      ShipTo: { Name: 'Destinataire', Address: addr(to) },
      ShipmentRatingOptions: { NegotiatedRatesIndicator: '' },
      Package: parcels.map(p => ({
        PackagingType: { Code: '02' },
        Dimensions: { UnitOfMeasurement: { Code: 'CM' }, Length: String(p.length), Width: String(p.width), Height: String(p.height) },
        PackageWeight: { UnitOfMeasurement: { Code: 'KGS' }, Weight: String(p.weight) }
      }))
    } } };
  const r = await fetch(`${base()}/api/rating/${process.env.UPS_RATING_VERSION || 'v2409'}/Shop`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json',
               transId: crypto.randomUUID(), transactionSrc: 'transitpro' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('UPS rate ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return [].concat(j.RateResponse?.RatedShipment || []).map(s => {
    const neg = s.NegotiatedRateCharges?.TotalCharge;
    return { carrier: 'UPS', service: s.Service?.Code, cost: Number((neg || s.TotalCharges).MonetaryValue),
             negotiated: !!neg, days: Number(s.GuaranteedDelivery?.BusinessDaysInTransit) || null };
  });
};

// À implémenter et tester en sandbox avec votre compte : Shipping API (étiquette) + Pickup API (enlèvement)
exports.book = async () => { throw new Error('UPS book() non implémenté'); };
