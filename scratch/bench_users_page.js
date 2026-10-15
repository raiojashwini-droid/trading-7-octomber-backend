const db = require('../src/config/db');

(async () => {
    const week = '2026-10-05 00:00:00';
    const t0 = Date.now();
    const [users] = await db.query(
        "SELECT id FROM users WHERE role = 'TRADER' AND parent_id = 1 ORDER BY id DESC LIMIT 15"
    );
    const t1 = Date.now();
    const ids = users.map(u => u.id).join(',');
    const [stats] = await db.query(`
        SELECT t.user_id, SUM(t.pnl) gross_pl, COUNT(*) closed_trades_count
        FROM trades t
        INNER JOIN users u2 ON u2.id = t.user_id
        WHERE t.user_id IN (${ids})
          AND t.status = 'CLOSED'
          AND COALESCE(t.exit_time, t.entry_time) >= COALESCE(u2.last_reset_at, ?)
        GROUP BY t.user_id
    `, [week]);
    const t2 = Date.now();
    const [open] = await db.query(`
        SELECT user_id, COUNT(*) c FROM trades
        WHERE user_id IN (${ids}) AND status = 'OPEN'
        GROUP BY user_id
    `);
    const t3 = Date.now();
    console.log(JSON.stringify({
        usersMs: t1 - t0,
        statsMs: t2 - t1,
        openMs: t3 - t2,
        totalMs: t3 - t0,
        userCount: users.length,
        statRows: stats.length,
        openRows: open.length
    }));
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
