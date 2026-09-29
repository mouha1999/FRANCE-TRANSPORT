# TransitPro – serveur d'affrètement

Flux : photo + colisage → devis automatique (meilleur tarif de VOS comptes UPS / FedEx / DHL + marge) →
le client accepte → mail à l'exploitant + mail neutre au client. Le client ne voit jamais le nom du transporteur.

## Démarrage
1. `cp .env.example .env` puis remplir (clés API, comptes, SMTP). Ne jamais mettre les clés ailleurs que dans `.env`.
2. `npm install && npm start` puis ouvrir http://localhost:3000
3. Admin (coûts, transporteur, marge) : `GET /api/admin/quotes` avec l'en-tête `x-admin-token`.

## Tarifs négociés
Les numéros de compte sont envoyés à chaque appel. Le champ `negotiated` indique si le tarif de votre compte
a bien été renvoyé. Si `false`, vous recevez un mail « TARIF PUBLIC ».

## À faire avant la mise en production
- `book()` dans `carriers/*.js` : étiquette + enlèvement (à tester en sandbox). En attendant, l'exploitant reçoit un mail « À ENLEVER ».
- Passer les URL sandbox en production dans `.env` (identifiants différents).
- Hors gabarit (armoire...) : devis manuel par mail. Brancher DHL Freight / FedEx Freight (LTL) / UPS Freight ou un affréteur.
- Héberger en HTTPS (Render, Railway, Scaleway...) et remplacer `data.json` par une vraie base (PostgreSQL).
- Discrétion : couper les notifications transporteur au client, ne pas lui transmettre le tracking d'origine.
