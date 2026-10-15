const db = require('../src/config/db');

async function fastClean() {
    try {
        console.log('⚡ Starting instant cleanup of test data...');

        // 1. Truncate trades table (instantaneous deletion of load test trades)
        await db.execute("TRUNCATE TABLE trades");
        console.log('✅ trades table truncated instantly.');

        // 2. Delete client_settings, user_documents, ledger, and test users
        await db.execute("DELETE FROM client_settings WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loaduser_%')");
        await db.execute("DELETE FROM user_documents WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loaduser_%')");
        await db.execute("DELETE FROM ledger WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'loaduser_%')");
        
        const [uRes] = await db.execute("DELETE FROM users WHERE username LIKE 'loaduser_%'");
        console.log(`✅ Deleted ${uRes.affectedRows} test users.`);

        const [userCount] = await db.execute("SELECT COUNT(*) as count FROM users");
        console.log(`📊 Clean Users Count Remaining: ${userCount[0].count}`);

        console.log('\n🎉 Instant DB Cleanup Completed Successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error during fastClean:', err);
        process.exit(1);
    }
}

fastClean();
