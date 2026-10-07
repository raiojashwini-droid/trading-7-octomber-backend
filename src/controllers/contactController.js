const db = require('../config/db');

/**
 * Public endpoint: Submit a new contact inquiry (from App / Webview)
 */
exports.submitInquiry = async (req, res) => {
    try {
        const { name, phone, message } = req.body;
        if (!name || !phone || !message) {
            return res.status(400).json({ success: false, message: 'Name, phone and message are required.' });
        }

        const [result] = await db.execute(
            'INSERT INTO contact_inquiries (name, phone, message) VALUES (?, ?, ?)',
            [name.trim(), phone.trim(), message.trim()]
        );

        return res.status(201).json({
            success: true,
            message: 'Inquiry submitted successfully.',
            data: { id: result.insertId }
        });
    } catch (err) {
        console.error('[ContactController] submitInquiry error:', err);
        return res.status(500).json({ success: false, message: 'Failed to submit inquiry.' });
    }
};

/**
 * Admin endpoint: List all contact inquiries
 */
exports.getInquiries = async (req, res) => {
    try {
        const { status, search } = req.query;
        let query = 'SELECT * FROM contact_inquiries WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        if (search) {
            query += ' AND (name LIKE ? OR phone LIKE ? OR message LIKE ?)';
            const q = `%${search}%`;
            params.push(q, q, q);
        }

        query += ' ORDER BY created_at DESC';

        const [rows] = await db.execute(query, params);
        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[ContactController] getInquiries error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch inquiries.' });
    }
};

/**
 * Admin endpoint: Update inquiry status / remarks
 */
exports.updateInquiry = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, remarks } = req.body;

        const updates = [];
        const params = [];

        if (status) {
            updates.push('status = ?');
            params.push(status);
        }
        if (remarks !== undefined) {
            updates.push('remarks = ?');
            params.push(remarks);
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update.' });
        }

        params.push(id);
        await db.execute(`UPDATE contact_inquiries SET ${updates.join(', ')} WHERE id = ?`, params);

        return res.json({ success: true, message: 'Inquiry updated successfully.' });
    } catch (err) {
        console.error('[ContactController] updateInquiry error:', err);
        return res.status(500).json({ success: false, message: 'Failed to update inquiry.' });
    }
};

/**
 * Admin endpoint: Delete an inquiry
 */
exports.deleteInquiry = async (req, res) => {
    try {
        const { id } = req.params;
        await db.execute('DELETE FROM contact_inquiries WHERE id = ?', [id]);
        return res.json({ success: true, message: 'Inquiry deleted successfully.' });
    } catch (err) {
        console.error('[ContactController] deleteInquiry error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete inquiry.' });
    }
};
