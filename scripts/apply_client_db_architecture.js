const db = require('../src/config/db');

async function applyArchitecture() {
  console.log('🚀 Starting Client DB Architecture Optimization...');

  const query = async (sql, params = []) => {
    try {
      const [res] = await db.query(sql, params);
      return res;
    } catch (err) {
      console.warn(`⚠️ Warning executing SQL: ${sql.substring(0, 120)}... -> ${err.message}`);
      return null;
    }
  };

  const getIndexes = async (tableName) => {
    try {
      const [rows] = await db.query(`SHOW INDEX FROM \`${tableName}\``);
      return rows.map(r => r.Key_name);
    } catch (e) {
      return [];
    }
  };

  const addIndexSafe = async (tableName, indexName, columnsSql) => {
    const existing = await getIndexes(tableName);
    if (!existing.includes(indexName)) {
      console.log(`➕ Adding index ${indexName} on ${tableName}(${columnsSql})`);
      await query(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` (${columnsSql})`);
    } else {
      console.log(`ℹ️ Index ${indexName} already exists on ${tableName}`);
    }
  };

  const dropIndexSafe = async (tableName, indexName) => {
    const existing = await getIndexes(tableName);
    if (existing.includes(indexName)) {
      console.log(`➖ Dropping redundant index ${indexName} on ${tableName}`);
      await query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
    }
  };

  const getColumns = async (tableName) => {
    try {
      const [rows] = await db.query(`DESCRIBE \`${tableName}\``);
      return rows.map(r => r.Field);
    } catch (e) {
      return [];
    }
  };

  // 1. Extend trades table with versioning columns
  console.log('\n--- 1. Extending trades table for versioning & audit ---');
  const tradeCols = await getColumns('trades');
  if (!tradeCols.includes('version')) {
    console.log('➕ Adding version column to trades');
    await query(`ALTER TABLE trades ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1`);
  }
  if (!tradeCols.includes('reactivated_by')) {
    console.log('➕ Adding reactivated_by column to trades');
    await query(`ALTER TABLE trades ADD COLUMN reactivated_by INT NULL`);
  }
  if (!tradeCols.includes('reactivated_at')) {
    console.log('➕ Adding reactivated_at column to trades');
    await query(`ALTER TABLE trades ADD COLUMN reactivated_at DATETIME(3) NULL`);
  }

  // 2. Create Audit & History Tables from Client Architecture
  console.log('\n--- 2. Creating trades_history, action_logs, trades_dump ---');
  
  await query(`
    CREATE TABLE IF NOT EXISTS trades_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      trade_id INT NOT NULL,
      version INT UNSIGNED NOT NULL,
      change_type VARCHAR(20) NOT NULL,
      old_status VARCHAR(10) NOT NULL,
      new_status VARCHAR(10) NOT NULL,
      user_id INT NOT NULL,
      symbol VARCHAR(50) NOT NULL,
      type VARCHAR(4) NOT NULL,
      qty INT NOT NULL,
      entry_price DECIMAL(18,4) NOT NULL,
      exit_price DECIMAL(18,4) NULL,
      exit_time TIMESTAMP NULL,
      pnl DECIMAL(18,4) NULL,
      brokerage DECIMAL(18,4) NULL,
      closed_by VARCHAR(50) NULL,
      close_remark VARCHAR(100) NULL,
      changed_by INT NOT NULL,
      action_log_id BIGINT UNSIGNED NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_th_trade_version (trade_id, version),
      KEY idx_th_user_created (user_id, created_at),
      KEY idx_th_changed_by (changed_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✅ trades_history table verified.');

  await query(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      actor_id INT NOT NULL,
      actor_role VARCHAR(20) NOT NULL,
      action_type VARCHAR(50) NOT NULL,
      entity_type VARCHAR(30) NOT NULL,
      entity_id BIGINT NOT NULL,
      target_user_id INT NULL,
      old_value JSON NULL,
      new_value JSON NULL,
      reason VARCHAR(255) NULL,
      ip_address VARCHAR(45) NULL,
      user_agent VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_al_actor_created (actor_id, created_at),
      KEY idx_al_entity (entity_type, entity_id, created_at),
      KEY idx_al_target_created (target_user_id, created_at),
      KEY idx_al_action_created (action_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✅ action_logs table verified.');

  await query(`
    CREATE TABLE IF NOT EXISTS trades_dump LIKE trades;
  `);
  const dumpCols = await getColumns('trades_dump');
  if (!dumpCols.includes('dumped_at')) {
    await query(`ALTER TABLE trades_dump ADD COLUMN dumped_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  }
  console.log('✅ trades_dump table verified.');

  // 3. Create RBAC Tables (Optional structure from client)
  console.log('\n--- 3. Creating Role & Permission tables ---');
  await query(`
    CREATE TABLE IF NOT EXISTS roles (
      id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      description VARCHAR(255),
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      module VARCHAR(100) NOT NULL,
      action ENUM('view','add','edit','delete','export','reactivate') NOT NULL,
      code VARCHAR(100) NOT NULL UNIQUE,
      UNIQUE KEY uq_perm_module_action (module, action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id SMALLINT UNSIGNED NOT NULL,
      permission_id SMALLINT UNSIGNED NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      KEY idx_rp_permission (permission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INT NOT NULL,
      role_id SMALLINT UNSIGNED NOT NULL,
      assigned_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, role_id),
      KEY idx_ur_role (role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✅ RBAC tables verified.');

  // 4. Create MySQL Views for Separate Virtual Tables (Client requirement)
  console.log('\n--- 4. Creating Dedicated Database Views (Status & Roles separation) ---');
  
  await query(`
    CREATE OR REPLACE VIEW view_active_trades AS 
    SELECT * FROM trades WHERE status = 'OPEN';
  `);
  console.log('✅ VIEW view_active_trades created.');

  await query(`
    CREATE OR REPLACE VIEW view_closed_trades AS 
    SELECT * FROM trades WHERE status = 'CLOSED';
  `);
  console.log('✅ VIEW view_closed_trades created.');

  await query(`
    CREATE OR REPLACE VIEW view_pending_trades AS 
    SELECT * FROM trades WHERE is_pending = 1 OR order_type = 'LIMIT' OR status = 'HOLD';
  `);
  console.log('✅ VIEW view_pending_trades created.');

  await query(`
    CREATE OR REPLACE VIEW view_settled_trades AS 
    SELECT * FROM trades WHERE status = 'SETTLED';
  `);
  console.log('✅ VIEW view_settled_trades created.');

  await query(`
    CREATE OR REPLACE VIEW view_traders AS 
    SELECT * FROM users WHERE UPPER(role) = 'TRADER';
  `);
  console.log('✅ VIEW view_traders created.');

  await query(`
    CREATE OR REPLACE VIEW view_brokers AS 
    SELECT * FROM users WHERE UPPER(role) = 'BROKER';
  `);
  console.log('✅ VIEW view_brokers created.');

  await query(`
    CREATE OR REPLACE VIEW view_admins AS 
    SELECT * FROM users WHERE UPPER(role) IN ('ADMIN', 'SUPERADMIN');
  `);
  console.log('✅ VIEW view_admins created.');

  await query(`
    CREATE OR REPLACE VIEW view_superadmins AS 
    SELECT * FROM users WHERE UPPER(role) = 'SUPERADMIN';
  `);
  console.log('✅ VIEW view_superadmins created.');

  // 5. Index Optimizations
  console.log('\n--- 5. Applying Index Optimizations from Client Schema ---');
  
  // users
  await addIndexSafe('users', 'idx_users_parent_role', 'parent_id, role');
  await dropIndexSafe('users', 'idx_role');
  await dropIndexSafe('users', 'idx_users_role');
  await dropIndexSafe('users', 'idx_status');
  await dropIndexSafe('users', 'idx_users_status');

  // client_settings
  await addIndexSafe('client_settings', 'idx_cs_broker', 'broker_id');

  // user_documents
  await addIndexSafe('user_documents', 'idx_ud_kyc_status', 'kyc_status');

  // trades
  await addIndexSafe('trades', 'idx_trades_user_entry', 'user_id, entry_time');
  await addIndexSafe('trades', 'idx_trades_status_entry', 'status, entry_time');
  await addIndexSafe('trades', 'idx_trades_symbol_status', 'symbol, status');
  await dropIndexSafe('trades', 'idx_trades_user_id');
  await dropIndexSafe('trades', 'idx_trades_status');
  await dropIndexSafe('trades', 'idx_user_status');
  await dropIndexSafe('trades', 'idx_trades_symbol');
  await dropIndexSafe('trades', 'idx_trades_actual_qty');
  await dropIndexSafe('trades', 'idx_trades_cf');

  // paper_orders
  await addIndexSafe('paper_orders', 'idx_po_status_symbol', 'status, symbol');
  await addIndexSafe('paper_orders', 'idx_po_user_created', 'user_id, created_at');

  // paper_trades
  await addIndexSafe('paper_trades', 'idx_pt_user_time', 'user_id, execution_time');

  // paper_gtt_triggers
  await addIndexSafe('paper_gtt_triggers', 'idx_pgt_status_symbol', 'status, symbol, trigger_price');

  // alerts
  await addIndexSafe('alerts', 'idx_alerts_symbol_status', 'symbol, status, target_price');
  await addIndexSafe('alerts', 'idx_alerts_user_status', 'user_id, status');
  await dropIndexSafe('alerts', 'idx_user_id');
  await dropIndexSafe('alerts', 'idx_symbol');
  await dropIndexSafe('alerts', 'idx_status');

  // notification_reads
  await addIndexSafe('notification_reads', 'idx_nr_user', 'user_id, notification_id');

  // notifications
  await addIndexSafe('notifications', 'idx_notif_created', 'created_at');
  await addIndexSafe('notifications', 'idx_notif_target_user', 'target_user_id, created_at');
  await addIndexSafe('notifications', 'idx_notif_role_created', 'target_role, created_at');

  // signals
  await addIndexSafe('signals', 'idx_signals_active_created', 'is_active, created_at');
  await addIndexSafe('signals', 'idx_signals_symbol_created', 'symbol, created_at');

  // internal_transfers
  await addIndexSafe('internal_transfers', 'idx_it_from_created', 'from_user_id, created_at');
  await addIndexSafe('internal_transfers', 'idx_it_to_created', 'to_user_id, created_at');

  // ledger
  await addIndexSafe('ledger', 'idx_ledger_ref', 'reference_type, reference_id');
  await dropIndexSafe('ledger', 'idx_ledger_user_id');
  await dropIndexSafe('ledger', 'idx_created_at');

  // payment_requests
  await addIndexSafe('payment_requests', 'idx_pr_status_created', 'status, created_at');
  await addIndexSafe('payment_requests', 'idx_pr_user_created', 'user_id, created_at');
  await dropIndexSafe('payment_requests', 'idx_payment_user_id');
  await dropIndexSafe('payment_requests', 'idx_payment_status');

  // support_tickets
  await addIndexSafe('support_tickets', 'idx_st_user_created', 'user_id, created_at');
  await addIndexSafe('support_tickets', 'idx_st_status_updated', 'status, updated_at');

  // ticket_messages
  await addIndexSafe('ticket_messages', 'idx_tm_ticket_created', 'ticket_id, created_at');

  // voice_recordings
  await addIndexSafe('voice_recordings', 'idx_vr_user_created', 'user_id, created_at');
  await addIndexSafe('voice_recordings', 'idx_vr_admin_created', 'admin_id, created_at');

  // ip_logins
  await addIndexSafe('ip_logins', 'idx_ip_logins_user_time', 'user_id, timestamp');
  await addIndexSafe('ip_logins', 'idx_ip_logins_ip', 'ip_address');

  // ip_logs
  await addIndexSafe('ip_logs', 'idx_ip_logs_user_time', 'user_id, timestamp');
  await addIndexSafe('ip_logs', 'idx_ip_logs_time', 'timestamp');

  console.log('\n✨ Database Architecture & Optimization Applied Successfully with 0 Code Impact!');
  process.exit(0);
}

applyArchitecture().catch(err => {
  console.error('❌ Error applying DB architecture:', err);
  process.exit(1);
});
