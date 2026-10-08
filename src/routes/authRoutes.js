const express = require('express');
const router = express.Router();
const { login, createUser, updateTransactionPassword, changePassword, verifyTransactionPassword, getMe } = require('../controllers/authController');
const { authMiddleware, roleMiddleware, brokerPermission } = require('../middleware/auth');

router.post('/login', login);
router.get('/me', authMiddleware, getMe);
router.post('/create-user', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), brokerPermission('createClientsAllowed'), createUser);
router.post('/change-transaction-password', authMiddleware, updateTransactionPassword);
router.post('/change-password', authMiddleware, changePassword);
router.post('/verify-transaction-password', authMiddleware, verifyTransactionPassword);

router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;
