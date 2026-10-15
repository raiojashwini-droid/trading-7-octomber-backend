const db = require('../src/config/db');

async function checkTestData() {
    try {
        const [testUsers] = await db.execute("SELECT COUNT(*) as count FROM users WHERE username LIKE 'loaduser_%'");
        const [totalUsers] = await db.execute("SELECT COUNT(*) as total FROM users");
        const [totalTrades] = await db.execute("SELECT COUNT(*) as total FROM trades");
        
        console.log(`Total users in DB: ${totalUsers[0].total}`);
        console.log(`Test users (loaduser_%): ${testUsers[0].count}`);
        console.log(`Total trades in DB: ${totalTrades[0].total}`);

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkTestData();
