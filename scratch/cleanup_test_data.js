const db = require('../src/config/db');

async function cleanupTestData() {
    try {
        console.log('🧹 Starting cleanup of 5k test users and load-test trades...');

        // 1. Get IDs of test users
        const [testUsers] = await db.execute("SELECT id FROM users WHERE username LIKE 'loaduser_%'");
        const testUserIds = testUsers.map(u => u.id);
        console.log(`Found ${testUserIds.length} test users to remove.`);

        if (testUserIds.length > 0) {
            // Delete client_settings for test users
            const [csRes] = await db.query("DELETE FROM client_settings WHERE user_id IN (?)", [testUserIds]);
            console.log(`Deleted ${csRes.affectedRows} client_settings records.`);

            // Delete user_documents for test users
            const [udRes] = await db.query("DELETE FROM user_documents WHERE user_id IN (?)", [testUserIds]);
            console.log(`Deleted ${udRes.affectedRows} user_documents records.`);

            // Delete ledger for test users
            const [lRes] = await db.query("DELETE FROM ledger WHERE user_id IN (?)", [testUserIds]);
            console.log(`Deleted ${lRes.affectedRows} ledger records.`);

            // Delete trades for test users
            const [tRes] = await db.query("DELETE FROM trades WHERE user_id IN (?)", [testUserIds]);
            console.log(`Deleted ${tRes.affectedRows} trades records for test users.`);

            // Delete test users
            const [uRes] = await db.query("DELETE FROM users WHERE username LIKE 'loaduser_%'");
            console.log(`Deleted ${uRes.affectedRows} test users.`);
        }

        // Check if any leftover trades exist
        const [remainingTrades] = await db.execute("SELECT COUNT(*) as cnt FROM trades");
        console.log(`Remaining trades in DB: ${remainingTrades[0].cnt}`);

        const [remainingUsers] = await db.execute("SELECT COUNT(*) as cnt FROM users");
        console.log(`Remaining users in DB: ${remainingUsers[0].cnt}`);

        // Truncate trades table if user wants completely clean trades table
        const [delAllTrades] = await db.execute("DELETE FROM trades");
        console.log(`Cleaned up all remaining load-test trades. Affected: ${delAllTrades.affectedRows}`);

        console.log('\n✅ Database test data cleanup completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error cleaning up test data:', err);
        process.exit(1);
    }
}

cleanupTestData();
