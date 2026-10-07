const cron = require('node-cron');
const db = require('../config/db');
const { sendPdfReportAndPurge } = require('../controllers/scripTickController');

/**
 * Initialize Weekly Script Data Cleanup & PDF Export Cron Job
 */
const initScripCleanupCron = () => {
    console.log('⏰ [scripCleanupCron] Initializing Weekly Script Data Cleanup Cron (Every Sunday at 00:00)...');

    // Run every Sunday at midnight (00:00)
    cron.schedule('0 0 * * 0', async () => {
        console.log('🔄 [scripCleanupCron] Running weekly automated script data export & purge...');
        try {
            const result = await sendPdfReportAndPurge({ forceAll: true });
            console.log(`✅ [scripCleanupCron] Weekly cleanup completed. All records archived and purged. ZIP emailed to ${result.emailSentTo}`);
        } catch (err) {
            console.error('❌ [scripCleanupCron] Error during weekly script data cleanup:', err.message);
        }
    });
};

module.exports = { initScripCleanupCron };
