const db = require('../config/db');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { fork } = require('child_process');

/**
 * 1. Fetch All Active / Registered Scrip Symbols Across Segments
 */
const isContractActive = (sym) => {
    if (!sym) return false;
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const match = sym.match(/(\d{2})([A-Z]{3})/);
    if (!match) return true; // Base symbols like BANKNIFTY, NIFTY, GOLD, etc.
    
    const year = 2000 + parseInt(match[1], 10);
    const monthStr = match[2];
    const month = months[monthStr];
    if (month === undefined) return true;
    
    // Contract expires on the last day of the contract month at 23:59:59
    const expiryDate = new Date(year, month + 1, 0, 23, 59, 59);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    return expiryDate >= today;
};

/**
 * 1. Get Scrip List for Dropdown (Matching Active Trading / Rollover Contracts)
 */
const getScripList = async (req, res) => {
    try {
        const symbolSet = new Set();

        // 1. Load active contracts from manually enabled & selected files (matching Live Quotes & Rollover)
        const dataDir = path.join(__dirname, '../data');
        const manFile = path.join(dataDir, 'manually_enabled_contracts.json');
        const selFile = path.join(dataDir, 'selected_contracts.json');
        const excFile = path.join(dataDir, 'excluded_contracts.json');

        let excluded = new Set();
        if (fs.existsSync(excFile)) {
            try {
                const arr = JSON.parse(fs.readFileSync(excFile, 'utf8'));
                if (Array.isArray(arr)) arr.forEach(s => excluded.add(s));
            } catch (_) {}
        }

        [manFile, selFile].forEach(f => {
            if (fs.existsSync(f)) {
                try {
                    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
                    if (Array.isArray(arr)) {
                        arr.forEach(sym => {
                            if (!excluded.has(sym)) {
                                const clean = sym.includes(':') ? sym.split(':')[1] : sym;
                                if (isContractActive(clean)) {
                                    symbolSet.add(clean);
                                }
                            }
                        });
                    }
                } catch (_) {}
            }
        });

        // 2. Load active Market Group Items
        const [mgiRows] = await db.execute(`
            SELECT mgi.symbol 
            FROM market_group_items mgi 
            JOIN market_groups mg ON mgi.group_id = mg.id
            WHERE mg.name IN ('COMMODITY', 'MCX FUTURES', 'CRYPTO', 'FOREX', 'NFO INDICES')
               OR mgi.symbol LIKE '%FUT%' 
               OR mgi.symbol LIKE '%CE%' 
               OR mgi.symbol LIKE '%PE%'
        `);
        mgiRows.forEach(r => r.symbol && isContractActive(r.symbol) && symbolSet.add(r.symbol));

        const contractController = require('./contractController');
        await contractController.getActiveContractSymbolsSet().catch(() => {});
        const activeSet = global.ACTIVE_AUTOMATED_SYMBOLS_SET;
        const globalExcluded = global.EXCLUDED_CONTRACTS ? new Set(global.EXCLUDED_CONTRACTS) : new Set();

        const isAllowedScrip = (cleanSym) => {
            const isDeriv = cleanSym.includes('FUT') || cleanSym.includes('CE') || cleanSym.includes('PE');
            if (!isDeriv) return true;

            if (globalExcluded.has(cleanSym) || globalExcluded.has(`MCX:${cleanSym}`) || globalExcluded.has(`NFO:${cleanSym}`)) {
                return false;
            }

            if (activeSet && activeSet.size > 0) {
                if (activeSet.has(cleanSym) || activeSet.has(`MCX:${cleanSym}`) || activeSet.has(`NFO:${cleanSym}`)) {
                    return true;
                }
                for (const item of activeSet) {
                    const itemClean = item.includes(':') ? item.split(':')[1] : item;
                    if (itemClean === cleanSym) return true;
                }
                return false;
            }
            return !excluded.has(cleanSym);
        };

        const scrips = Array.from(symbolSet).filter(isAllowedScrip).sort();
        return res.json({ success: true, count: scrips.length, data: scrips });
    } catch (err) {
        console.error('[scripTickController] Error fetching scrip list:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 2. Get Filtered Tick History Data (Matching attached UI filter)
 */
const getTickHistory = async (req, res) => {
    try {
        const { date, hour, minute, scripId, limit = 50, page = 1, cursor } = req.query;

        let whereClauses = [];
        let params = [];

        if (scripId && scripId !== 'ALL' && scripId !== 'Select Scrip') {
            const cleanScrip = String(scripId).trim();
            if (cleanScrip) {
                if (cleanScrip.includes('%')) {
                    whereClauses.push('scrip_id LIKE ?');
                    params.push(cleanScrip);
                } else {
                    whereClauses.push('(scrip_id = ? OR scrip_id LIKE ?)');
                    params.push(cleanScrip, `${cleanScrip}%`);
                }
            }
        }

        if (date) {
            let dateStr = date;
            if (date.includes('/')) {
                const parts = date.split('/');
                if (parts.length === 3) {
                    dateStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                }
            }

            const isHourValid = hour !== undefined && hour !== '' && hour !== 'ALL';
            const isMinuteValid = minute !== undefined && minute !== '' && minute !== 'ALL';

            // Server runs in IST (TZ=Asia/Kolkata), use date/time directly
            if (isHourValid && isMinuteValid) {
                const hStr = String(hour).padStart(2, '0');
                const mStr = String(minute).padStart(2, '0');
                whereClauses.push('system_time BETWEEN ? AND ?');
                params.push(`${dateStr} ${hStr}:${mStr}:00`, `${dateStr} ${hStr}:${mStr}:59`);
            } else if (isHourValid) {
                const hStr = String(hour).padStart(2, '0');
                whereClauses.push('system_time BETWEEN ? AND ?');
                params.push(`${dateStr} ${hStr}:00:00`, `${dateStr} ${hStr}:59:59`);
            } else if (isMinuteValid) {
                const mStr = String(minute).padStart(2, '0');
                whereClauses.push('system_time BETWEEN ? AND ? AND MINUTE(system_time) = ?');
                params.push(`${dateStr} 00:00:00`, `${dateStr} 23:59:59`, parseInt(mStr, 10));
            } else {
                whereClauses.push('system_time BETWEEN ? AND ?');
                params.push(`${dateStr} 00:00:00`, `${dateStr} 23:59:59`);
            }
        }

        // 1. Strict Server-Side Limit Clamping (Default: 50, Min: 1, Max: 1000)
        const rawLimit = parseInt(limit, 10);
        const parsedLimit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 1000);
        const parsedPage = parseInt(page, 10) || 1;

        // 2. Cursor Keyset Pagination Support (using unique monotonically increasing ID)
        let dataWhereClauses = [...whereClauses];
        let dataParams = [...params];
        const parsedCursor = cursor ? parseInt(cursor, 10) : null;
        let offset = 0;

        if (parsedCursor && !isNaN(parsedCursor) && parsedCursor > 0) {
            dataWhereClauses.push('id < ?');
            dataParams.push(parsedCursor);
        } else {
            offset = (parsedPage - 1) * parsedLimit;
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const dataWhereSql = dataWhereClauses.length > 0 ? `WHERE ${dataWhereClauses.join(' AND ')}` : '';

        // 3. Ultra-Fast Parallel Query Execution (Count only when not paginating by cursor)
        const dataPromise = db.execute(
            `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp 
             FROM scrip_ticks_history 
             ${dataWhereSql} 
             ORDER BY id DESC 
             LIMIT ${parsedLimit} ${parsedCursor ? '' : `OFFSET ${offset}`}`,
            dataParams
        );

        const countPromise = parsedCursor
            ? Promise.resolve([{ total: 0 }])
            : db.execute(`SELECT COUNT(*) as total FROM scrip_ticks_history ${whereSql}`, params);

        const [[rows], countRes] = await Promise.all([dataPromise, countPromise]);
        const total = parsedCursor ? 0 : (countRes[0]?.[0]?.total || 0);

        const formattedRows = rows.map(r => ({
            id: r.id,
            scripId: r.scrip_id,
            exchangeTime: formatISTTimestamp(r.exchange_time),
            systemTime: formatISTTimestamp(r.system_time),
            bid: r.bid,
            ask: r.ask,
            high: r.high,
            low: r.low,
            ltp: r.ltp
        }));

        const nextCursor = formattedRows.length > 0 ? formattedRows[formattedRows.length - 1].id : null;
        const hasMore = formattedRows.length === parsedLimit;

        return res.json({
            success: true,
            total,
            page: parsedPage,
            limit: parsedLimit,
            items: formattedRows,
            nextCursor,
            hasMore
        });
    } catch (err) {
        console.error('[scripTickController] Error fetching tick history:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 3. Get Export Settings
 */
const getExportSettings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM scrip_export_settings WHERE id = 1');
        let settings = rows[0];

        if (!settings) {
            const [adminRows] = await db.execute(`SELECT email FROM users WHERE role = 'SUPERADMIN' AND email IS NOT NULL LIMIT 1`);
            const defaultEmail = adminRows[0]?.email || 'admin@trading.com';
            settings = {
                export_email: defaultEmail,
                export_destination: 'EMAIL',
                google_drive_folder_id: '',
                auto_clean_days: 7
            };
        }

        return res.json({ success: true, settings });
    } catch (err) {
        console.error('[scripTickController] Error fetching export settings:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 4. Update Export Settings
 */
const updateExportSettings = async (req, res) => {
    try {
        const { export_email, export_destination, google_drive_folder_id, auto_clean_days } = req.body;

        await db.execute(`
            INSERT INTO scrip_export_settings (id, export_email, export_destination, google_drive_folder_id, auto_clean_days)
            VALUES (1, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                export_email = VALUES(export_email),
                export_destination = VALUES(export_destination),
                google_drive_folder_id = VALUES(google_drive_folder_id),
                auto_clean_days = VALUES(auto_clean_days)
        `, [
            export_email || null,
            export_destination || 'EMAIL',
            google_drive_folder_id || null,
            parseInt(auto_clean_days, 10) || 7
        ]);

        return res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
        console.error('[scripTickController] Error updating settings:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Server runs in IST (TZ=Asia/Kolkata), new Date() gives IST directly
const formatISTTimestamp = (val) => {
    if (!val) return '';
    if (typeof val === 'string' && val.length >= 19 && !val.includes('Z') && !val.includes('+')) {
        return val.replace('T', ' ').slice(0, 19);
    }
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val).slice(0, 19);

    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatPdfTimestamp = (val) => formatISTTimestamp(val);

/**
 * Helper: Generate PDF File Stream
 */
const createPdfStream = (ticks, titleSub = '') => {
    const doc = new PDFDocument({ margin: 25, size: 'A4' });

    doc.fontSize(16).text('SUPERADMIN - SCRIPT TICK DATA REPORT', { align: 'center' });
    doc.fontSize(9).text(`Generated On: ${formatPdfTimestamp(new Date())} ${titleSub ? ' | ' + titleSub : ''}`, { align: 'center' });
    doc.moveDown(1.2);

    const startY = doc.y;
    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('ID', 25, startY, { width: 45 });
    doc.text('Scrip ID', 72, startY, { width: 110 });
    doc.text('Exchange Time', 185, startY, { width: 105 });
    doc.text('System Time', 293, startY, { width: 105 });
    doc.text('Bid', 400, startY, { width: 50, align: 'right' });
    doc.text('Ask', 452, startY, { width: 50, align: 'right' });
    doc.text('LTP', 505, startY, { width: 55, align: 'right' });
    doc.moveDown(0.5);

    doc.moveTo(25, doc.y).lineTo(565, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7);
    ticks.forEach((t) => {
        if (doc.y > 760) {
            doc.addPage();
            doc.moveTo(25, 25).lineTo(565, 25).stroke();
            doc.y = 30;
        }

        const y = doc.y;
        doc.text(String(t.id), 25, y, { width: 45 });
        doc.text(String(t.scrip_id || t.scripId || ''), 72, y, { width: 110 });
        doc.text(formatPdfTimestamp(t.exchange_time || t.exchangeTime), 185, y, { width: 105 });
        doc.text(formatPdfTimestamp(t.system_time || t.systemTime), 293, y, { width: 105 });
        doc.text(Number(t.bid || 0).toFixed(2), 400, y, { width: 50, align: 'right' });
        doc.text(Number(t.ask || 0).toFixed(2), 452, y, { width: 50, align: 'right' });
        doc.text(Number(t.ltp || 0).toFixed(2), 505, y, { width: 55, align: 'right' });
        doc.moveDown(0.2);
    });

    return doc;
};

/**
 * 5. Download PDF directly from UI
 */
const downloadPdf = async (req, res) => {
    try {
        const { date, scripId } = req.query;
        let whereClauses = [];
        let params = [];

        if (scripId && scripId !== 'ALL' && scripId !== 'Select Scrip') {
            whereClauses.push('scrip_id = ?');
            params.push(scripId);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const [rows] = await db.execute(
            `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp 
             FROM scrip_ticks_history ${whereSql} ORDER BY id DESC LIMIT 2000`,
            params
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=script_data_${Date.now()}.pdf`);

        const doc = createPdfStream(rows, `Scrip: ${scripId || 'All'}`);
        doc.pipe(res);
        doc.end();
    } catch (err) {
        console.error('[scripTickController] Error downloading PDF:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getWorkerPath = () => {
    return path.join(__dirname, '../workers/s3ExportWorker.js');
};

/**
 * 6. Send Email with Attachment/S3 Link & Purge Database via Isolated Worker Process
 */
const sendPdfReportAndPurge = async ({ forceAll = false, daysBefore = 7 } = {}) => {
    const [settingsRows] = await db.execute('SELECT export_email FROM scrip_export_settings WHERE id = 1');
    const targetEmail = settingsRows[0]?.export_email || 'superadmin@trading.com';

    const workerPath = getWorkerPath();
    const worker = fork(workerPath, [JSON.stringify({ forceAll, daysBefore })], { execArgv: ['--max-old-space-size=4096'] });

    worker.on('exit', (code) => {
        console.log(`[scripTickController] 👷 Worker process finished with exit code ${code}`);
    });

    return { count: 0, emailSentTo: targetEmail };
};

/**
 * 7. Manual Trigger Endpoint for Export & Purge
 */
const triggerCleanup = async (req, res) => {
    try {
        const { forceAll = false, daysBefore = 7 } = req.body;

        const [settingsRows] = await db.execute('SELECT export_email FROM scrip_export_settings WHERE id = 1');
        const targetEmail = settingsRows[0]?.export_email || 'superadmin@trading.com';

        const workerPath = getWorkerPath();
        const worker = fork(workerPath, [JSON.stringify({ forceAll, daysBefore })], { execArgv: ['--max-old-space-size=4096'] });

        worker.on('exit', (code) => {
            console.log(`[scripTickController] 👷 Worker process finished with exit code ${code}`);
        });

        const isS3 = workerPath.includes('s3ExportWorker');
        const exportType = isS3 ? 'Amazon S3 ZIP Archive with 7-Day Download Link' : 'PDF Report';

        return res.json({
            success: true,
            message: `⚡ Instant Export & Clear initiated! ${exportType} is being prepared and emailed to ${targetEmail} in background.`
        });
    } catch (err) {
        console.error('[scripTickController] Manual cleanup trigger error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

let cachedDates = null;
let lastDatesCacheTime = 0;
let cachedTotalDbCount = null;
let lastTotalCountCacheTime = 0;
const CACHE_TTL_MS = 30000;

/**
 * 8. Get Total Database Row Count for scrip_ticks_history
 */
const getTotalDbCount = async (req, res) => {
    try {
        const now = Date.now();
        if (cachedTotalDbCount !== null && (now - lastTotalCountCacheTime < CACHE_TTL_MS)) {
            return res.json({ success: true, count: cachedTotalDbCount });
        }
        const [cRows] = await db.execute("SELECT COUNT(id) as cnt FROM scrip_ticks_history");
        const count = parseInt(cRows[0]?.cnt || 0, 10);
        cachedTotalDbCount = count;
        lastTotalCountCacheTime = now;
        return res.json({ success: true, count });
    } catch (err) {
        console.error('[scripTickController] Error fetching total DB count:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 9. Get Dynamic Data-Driven Filter Options (Dates, Hours for Date, Minutes for Hour)
 */
const getFilterOptions = async (req, res) => {
    try {
        const { date, hour } = req.query;

        // 1. If no date provided, fetch all distinct available dates from scrip_ticks_history
        if (!date) {
            const now = Date.now();
            if (cachedDates !== null && (now - lastDatesCacheTime < CACHE_TTL_MS)) {
                return res.json({ success: true, dates: cachedDates });
            }
            const [dateRows] = await db.execute(`
                SELECT DATE(system_time) as tick_date 
                FROM scrip_ticks_history 
                WHERE system_time IS NOT NULL 
                GROUP BY DATE(system_time) 
                ORDER BY tick_date DESC
            `);
            const dates = dateRows.map(r => {
                if (!r.tick_date) return null;
                const d = new Date(r.tick_date);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            }).filter(Boolean);
            cachedDates = dates;
            lastDatesCacheTime = now;
            return res.json({ success: true, dates });
        }

        let dateStr = date;
        if (date.includes('/')) {
            const parts = date.split('/');
            if (parts.length === 3) {
                dateStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
        }

        // 2. If date + hour provided, fetch available minutes for that specific hour
        if (hour !== undefined && hour !== '' && hour !== 'ALL') {
            const hStr = String(hour).padStart(2, '0');
            const [minRows] = await db.execute(`
                SELECT DISTINCT LPAD(MINUTE(system_time), 2, '0') as tick_minute 
                FROM scrip_ticks_history 
                WHERE system_time BETWEEN ? AND ? 
                ORDER BY tick_minute ASC
            `, [`${dateStr} ${hStr}:00:00`, `${dateStr} ${hStr}:59:59`]);
            const minutes = minRows.map(r => String(r.tick_minute)).filter(Boolean);
            return res.json({ success: true, date: dateStr, hour: hStr, minutes });
        }

        // 3. If only date provided, fetch available hours for that date
        const [hourRows] = await db.execute(`
            SELECT DISTINCT LPAD(HOUR(system_time), 2, '0') as tick_hour 
            FROM scrip_ticks_history 
            WHERE system_time BETWEEN ? AND ? 
            ORDER BY tick_hour ASC
        `, [`${dateStr} 00:00:00`, `${dateStr} 23:59:59`]);
        const hours = hourRows.map(r => String(r.tick_hour)).filter(Boolean);
        return res.json({ success: true, date: dateStr, hours });
    } catch (err) {
        console.error('[scripTickController] Error fetching filter options:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    getScripList,
    getTickHistory,
    getExportSettings,
    updateExportSettings,
    downloadPdf,
    triggerCleanup,
    sendPdfReportAndPurge,
    getTotalDbCount,
    getFilterOptions
};

