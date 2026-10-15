const db = require('../src/config/db');

async function rollbackArchitecture() {
  console.log('🔄 Starting Rollback of Client DB Architecture...');

  const query = async (sql) => {
    try {
      const [res] = await db.query(sql);
      return res;
    } catch (err) {
      console.warn(`⚠️ Warning: ${sql.substring(0, 100)} -> ${err.message}`);
      return null;
    }
  };

  // 1. Drop Views
  console.log('\n--- 1. Dropping Views ---');
  await query('DROP VIEW IF EXISTS view_active_trades');
  await query('DROP VIEW IF EXISTS view_closed_trades');
  await query('DROP VIEW IF EXISTS view_pending_trades');
  await query('DROP VIEW IF EXISTS view_settled_trades');
  await query('DROP VIEW IF EXISTS view_traders');
  await query('DROP VIEW IF EXISTS view_brokers');
  await query('DROP VIEW IF EXISTS view_admins');
  await query('DROP VIEW IF EXISTS view_superadmins');
  console.log('✅ Views dropped.');

  // 2. Drop newly created tables (if needed)
  console.log('\n--- 2. Dropping History / Dump / RBAC tables ---');
  await query('DROP TABLE IF EXISTS trades_history');
  await query('DROP TABLE IF EXISTS action_logs');
  await query('DROP TABLE IF EXISTS trades_dump');
  await query('DROP TABLE IF EXISTS user_roles');
  await query('DROP TABLE IF EXISTS role_permissions');
  await query('DROP TABLE IF EXISTS permissions');
  await query('DROP TABLE IF EXISTS roles');
  console.log('✅ Tables dropped.');

  console.log('\n✨ Rollback Completed Successfully!');
  process.exit(0);
}

rollbackArchitecture().catch(err => {
  console.error('❌ Error during rollback:', err);
  process.exit(1);
});
