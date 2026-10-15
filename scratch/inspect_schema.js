const db = require('../src/config/db');

(async () => {
    const [cols] = await db.query('DESCRIBE trades');
    console.log('TRADES');
    cols.forEach(c => console.log([c.Field, c.Type, c.Null, c.Default].join('\t')));
    const [uc] = await db.query('DESCRIBE users');
    console.log('USERS');
    uc.forEach(c => console.log([c.Field, c.Type, c.Null, c.Default].join('\t')));
    const [admins] = await db.query("SELECT id, username, role FROM users WHERE role IN ('SUPERADMIN','ADMIN') ORDER BY FIELD(role,'SUPERADMIN','ADMIN'), id ASC LIMIT 10");
    console.log('ADMINS', JSON.stringify(admins));
    const [[ucount]] = await db.query('SELECT COUNT(*) c FROM users');
    const [[tcount]] = await db.query('SELECT COUNT(*) c FROM trades');
    const [[lt]] = await db.query("SELECT COUNT(*) c FROM users WHERE username LIKE 'loadtest_%'");
    console.log('counts', ucount.c, tcount.c, 'existing_loadtest', lt.c);
    process.exit(0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
