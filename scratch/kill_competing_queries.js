const db = require('../src/config/db');

(async () => {
    const [rows] = await db.query('SHOW FULL PROCESSLIST');
    for (const r of rows) {
        const info = r.Info || '';
        const isInsert = info.startsWith('INSERT INTO trades');
        const isAlter = info.startsWith('ALTER TABLE trades');
        const isHeavySelect = info.startsWith('SELECT') && Number(r.Time) > 20;
        if (isInsert) {
            console.log('keep insert', r.Id, 'time', r.Time);
            continue;
        }
        if (isAlter || isHeavySelect) {
            console.log('kill', r.Id, r.Time, info.slice(0, 80));
            try {
                await db.query('KILL ?', [r.Id]);
            } catch (err) {
                console.log('kill failed', r.Id, err.message);
            }
        }
    }
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
