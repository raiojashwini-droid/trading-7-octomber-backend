const express = require('express');
const router = express.Router();
const {
    submitInquiry,
    getInquiries,
    updateInquiry,
    deleteInquiry
} = require('../controllers/contactController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

// Public: App/Webview users can submit inquiries without being logged in
router.post('/', submitInquiry);

// Protected: Admins & Superadmins can view and manage contact inquiries
router.get('/', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getInquiries);
router.put('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateInquiry);
router.delete('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteInquiry);

module.exports = router;
