const express = require('express');
const router = express.Router();
const { authMiddleware, roleMiddleware } = require('../middleware/auth');
const {
    runSettlementNow,
    getSettlementsHistory,
    getSettlementConfig,
    updateSettlementConfig,
    runResetIDNow,
    getResetIDConfig
} = require('../controllers/weeklySettlementController');

// All settlement endpoints require authentication
router.use(authMiddleware);

// Get settlements history (Admins/SuperAdmins)
router.get('/', roleMiddleware(['SUPERADMIN', 'ADMIN']), getSettlementsHistory);

// Get settlement config
router.get('/config', roleMiddleware(['SUPERADMIN', 'ADMIN']), getSettlementConfig);

// Update settlement config (SuperAdmin Only)
router.put('/config', roleMiddleware(['SUPERADMIN']), updateSettlementConfig);

// Trigger settlement manually (SuperAdmin Only)
router.post('/run', roleMiddleware(['SUPERADMIN']), runSettlementNow);

// Trigger Reset ID manually (SuperAdmin Only)
router.post('/run-reset-id', roleMiddleware(['SUPERADMIN']), runResetIDNow);

// Get Reset ID config
router.get('/reset-id-config', roleMiddleware(['SUPERADMIN', 'ADMIN']), getResetIDConfig);

module.exports = router;

