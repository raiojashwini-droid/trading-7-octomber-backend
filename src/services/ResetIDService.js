const db = require('../config/db');
const { invalidateCache } = require('../utils/cacheManager');

let isResetRunning = false;

/**
 * Main function: Run Reset ID process across all active traders
 * Updates last_reset_at timestamp on users table so active view queries reset for the new week.
 */
async function runResetIDProcess({ resetByUserId = null, notes = null } = {}) {
    if (isResetRunning) {
        console.log('⚠️ [ResetIDService] Reset ID process is already in progress. Skipping duplicate call.');
        return {
            success: false,
            message: 'Reset ID process is already running. Please wait.'
        };
    }

    isResetRunning = true;
    console.log(`\n═════════════════════════════════════════════════════════════════`);
    console.log(`🚀 [ResetIDService] Starting Reset ID process...`);
    console.log(`═════════════════════════════════════════════════════════════════`);

    try {
        const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // 1. Update last_reset_at for all TRADER users
        const [updateResult] = await db.execute(
            `UPDATE users SET last_reset_at = NOW() WHERE role = 'TRADER'`
        );

        console.log(`✅ [ResetIDService] Updated last_reset_at for ${updateResult.affectedRows || 0} trader(s).`);

        // 2. Invalidate active user query cache so client list updates immediately
        try {
            await invalidateCache('users_*');
        } catch (_) {}

        // 3. Insert audit log record in reset_id_logs
        const resetType = resetByUserId ? 'MANUAL' : 'AUTO';
        const logNotes = notes || `Reset ID executed (${resetType})`;
        await db.execute(
            `INSERT INTO reset_id_logs (reset_by_user_id, reset_type, reset_at, notes)
             VALUES (?, ?, NOW(), ?)`,
            [resetByUserId, resetType, logNotes]
        );

        console.log(`🏁 [ResetIDService] Reset ID completed successfully.`);

        return {
            success: true,
            reset_at: nowStr,
            affected_traders: updateResult.affectedRows || 0,
            reset_type: resetType,
            message: 'Reset ID process executed successfully.'
        };
    } catch (err) {
        console.error('❌ [ResetIDService] Error executing Reset ID process:', err);
        throw err;
    } finally {
        isResetRunning = false;
    }
}

/**
 * Native IST Scheduler: Reads SuperAdmin config from expiry_rules and triggers Reset ID at exact time
 */
const startResetIDScheduler = () => {
    let lastResetWeekKey = '';

    // Check every 30 seconds to catch configured IST Reset Day & Time
    setInterval(async () => {
        try {
            const [rules] = await db.execute(
                `SELECT reset_id_day, reset_id_time, reset_id_enabled 
                 FROM expiry_rules WHERE reset_id_enabled = 'Yes' LIMIT 1`
            );

            const rule = rules[0] || {};
            const configDay = (rule.reset_id_day || 'Sunday').toLowerCase();
            const configTime = rule.reset_id_time || '12:00';

            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Kolkata',
                weekday: 'long',
                hour: 'numeric',
                minute: 'numeric',
                hour12: false
            }).formatToParts(now);

            let currentWeekday = '', currentH = -1, currentM = -1;
            parts.forEach(p => {
                if (p.type === 'weekday') currentWeekday = p.value.toLowerCase();
                if (p.type === 'hour') currentH = parseInt(p.value, 10) % 24;
                if (p.type === 'minute') currentM = parseInt(p.value, 10);
            });

            const [targetH, targetM] = configTime.split(':').map(Number);
            
            // Generate unique key for current date & time to prevent duplicate triggers
            const dateStr = now.toISOString().slice(0, 10);
            const currentTriggerKey = `${dateStr}_${configDay}_${configTime}`;

            // Trigger when matching configured Day and Hour/Minute in IST
            if (currentWeekday === configDay && currentH === targetH && currentM === targetM && lastResetWeekKey !== currentTriggerKey) {
                lastResetWeekKey = currentTriggerKey;
                console.log(`⏰ [ResetID Scheduler] Configured reset time reached (${configDay} ${configTime} IST). Triggering Reset ID...`);
                await runResetIDProcess();
            }
        } catch (err) {
            console.error('[ResetID Scheduler Error]:', err.message);
        }
    }, 30000);

    console.log('📅 Native IST Reset ID Scheduler initialized (Default: Sunday 12:00 PM IST).');
};

module.exports = {
    runResetIDProcess,
    startResetIDScheduler
};
