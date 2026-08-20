const { schedule } = require('@netlify/functions');
const { runLateCheck } = require('./_shared/late-check-core.js');

// 6h07 UTC ~ 7-8h du matin en Suisse selon la saison. Ajustable ici si besoin.
exports.handler = schedule('7 6 * * *', async () => {
  try {
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
    const result = await runLateCheck(siteUrl);
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log('Erreur alerte retard (non bloquant) :', e.message);
  }
  return { statusCode: 200 };
});
