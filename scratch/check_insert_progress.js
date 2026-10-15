const db = require('../src/config/db');
(async () => {
    const [rows] = await db.query('SHOW FULL PROCESSLIST');
    rows.forEach(r => {
        const info = (r.Info || '').replace(/\s+/g, ' ').slice(0, 180);
        console.log([r.Id, r.Time, r.State, info].join(' | '));
    });
    const [[c]] = await db.query("SELECT COUNT(*) c FROM trades");
    console.log('trade_count', c.c);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
