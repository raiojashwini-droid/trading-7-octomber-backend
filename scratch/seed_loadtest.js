/**
 * Load-test seed: 5000 traders + 2,000,000 trades.
 * Users are named loadtest_0001 ... loadtest_5000 and parented to superadmin.
 * About 2,000 trades stay OPEN. The rest are CLOSED, mostly before this week.
 *
 * Remove later:
 *   DELETE FROM trades WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loadtest_%');
 *   DELETE FROM users WHERE username LIKE 'loadtest_%';
 */
const db = require('../src/config/db');

const USER_COUNT = 5000;
const TRADE_COUNT = 2000000;
const PARENT_ID = 1;
const CHUNK = 200000;

const digit = (alias) =>
    `(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) ${alias}`;

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    const conn = await db.getConnection();
    try {
        const [[existing]] = await conn.query("SELECT COUNT(*) c FROM users WHERE username LIKE 'loadtest_%'");
        if (existing.c > 0) {
            throw new Error(`loadtest users already exist (${existing.c}). Delete them before seeding again.`);
        }

        log(`inserting ${USER_COUNT} traders under user ${PARENT_ID}`);
        const placeholders = [];
        const values = [];
        const password = '$2a$10$loadtest.hash.not.for.login.padding.value';
        for (let i = 1; i <= USER_COUNT; i++) {
            const username = `loadtest_${String(i).padStart(4, '0')}`;
            placeholders.push('(?,?,?,?,?,?,?,?)');
            values.push(username, password, `Load Test ${i}`, 'TRADER', 'Active', PARENT_ID, 100000, 0);
        }
        await conn.query(
            `INSERT INTO users (username, password, full_name, role, status, parent_id, balance, is_demo) VALUES ${placeholders.join(',')}`,
            values
        );

        const [idRows] = await conn.query("SELECT id FROM users WHERE username LIKE 'loadtest_%' ORDER BY id ASC");
        if (idRows.length !== USER_COUNT) {
            throw new Error(`expected ${USER_COUNT} users, inserted ${idRows.length}`);
        }
        const minId = idRows[0].id;
        const maxId = idRows[idRows.length - 1].id;
        if (maxId - minId + 1 !== USER_COUNT) {
            throw new Error(`user ids are not contiguous (${minId}..${maxId})`);
        }
        log(`users ${minId}..${maxId}`);

        await conn.query(
            "INSERT INTO client_settings (user_id, config_json) SELECT id, '{}' FROM users WHERE username LIKE 'loadtest_%'"
        );

        log('building 2,000,000 sequence numbers');
        await conn.query('DROP TEMPORARY TABLE IF EXISTS loadtest_seq');
        await conn.query('CREATE TEMPORARY TABLE loadtest_seq (n INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
        await conn.query(`
            INSERT INTO loadtest_seq (n)
            SELECT a.n + b.n*10 + c.n*100 + d.n*1000 + e.n*10000 + f.n*100000 + g.n*1000000
            FROM ${digit('a')}, ${digit('b')}, ${digit('c')}, ${digit('d')}, ${digit('e')}, ${digit('f')},
                 (SELECT 0 n UNION ALL SELECT 1) g
        `);

        await conn.query('SET unique_checks=0');
        await conn.query('SET foreign_key_checks=0');

        for (let start = 0; start < TRADE_COUNT; start += CHUNK) {
            const end = Math.min(start + CHUNK, TRADE_COUNT);
            log(`inserting trades ${start}..${end - 1}`);
            await conn.query(
                `
                INSERT INTO trades (
                    user_id, symbol, type, order_type, qty, entry_price, exit_price,
                    status, is_pending, market_type, entry_time, exit_time,
                    pnl, brokerage, swap, margin_used, created_by, lot_size_at_entry, qty_input, actual_qty
                )
                SELECT
                    ? + (s.n % ?),
                    ELT((s.n % 6) + 1, 'MCX:GOLD', 'MCX:SILVER', 'MCX:CRUDEOIL', 'MCX:NATURALGAS', 'MCX:COPPER', 'NSE:RELIANCE'),
                    IF(s.n % 2 = 0, 'BUY', 'SELL'),
                    'MARKET',
                    (s.n % 5) + 1,
                    1000 + (s.n % 5000) / 10,
                    IF(s.n % 1000 = 0, NULL, 1000 + ((s.n % 5000) / 10) + ((s.n % 40) - 20)),
                    IF(s.n % 1000 = 0, 'OPEN', 'CLOSED'),
                    0,
                    IF(s.n % 6 = 5, 'NSE', 'MCX'),
                    CASE
                        WHEN s.n % 1000 = 0 THEN DATE_SUB(NOW(), INTERVAL (s.n % 2) DAY)
                        WHEN s.n % 200 = 1 THEN DATE_SUB(NOW(), INTERVAL (s.n % 5) DAY)
                        ELSE DATE_SUB(NOW(), INTERVAL (40 + (s.n % 300)) DAY)
                    END,
                    CASE
                        WHEN s.n % 1000 = 0 THEN NULL
                        WHEN s.n % 200 = 1 THEN DATE_SUB(NOW(), INTERVAL (s.n % 5) DAY) + INTERVAL 2 HOUR
                        ELSE DATE_SUB(NOW(), INTERVAL (40 + (s.n % 300)) DAY) + INTERVAL 2 HOUR
                    END,
                    IF(s.n % 1000 = 0, 0, ((s.n % 100) - 50) * ((s.n % 5) + 1)),
                    10 + (s.n % 20),
                    s.n % 5,
                    500 + (s.n % 200),
                    ?,
                    IF(s.n % 6 = 5, 1, 100),
                    (s.n % 5) + 1,
                    IF(s.n % 6 = 5, (s.n % 5) + 1, ((s.n % 5) + 1) * 100)
                FROM loadtest_seq s
                WHERE s.n >= ? AND s.n < ?
                `,
                [minId, USER_COUNT, PARENT_ID, start, end]
            );
        }

        const [[users]] = await conn.query("SELECT COUNT(*) c FROM users WHERE username LIKE 'loadtest_%'");
        const [[trades]] = await conn.query(
            "SELECT COUNT(*) c, SUM(status='OPEN') opens, SUM(status='CLOSED') closed FROM trades WHERE user_id BETWEEN ? AND ?",
            [minId, maxId]
        );
        log(`done users=${users.c} trades=${trades.c} open=${trades.opens} closed=${trades.closed}`);
    } finally {
        conn.release();
    }
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
