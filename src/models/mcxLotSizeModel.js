const db = require('../config/db');

const INITIAL_MCX_LOT_SIZES = [
    { symbol: 'CRUDEOIL', lot_size: 100, description: 'Crude Oil Mega' },
    { symbol: 'CRUDEOILM', lot_size: 10, description: 'Crude Oil Mini' },
    { symbol: 'MCRUDEOIL', lot_size: 10, description: 'Crude Oil Mini Alternate' },
    { symbol: 'NATURALGAS', lot_size: 1250, description: 'Natural Gas Mega' },
    { symbol: 'NATGASMINI', lot_size: 250, description: 'Natural Gas Mini' },
    { symbol: 'MNATURALGAS', lot_size: 250, description: 'Natural Gas Mini Alternate' },
    { symbol: 'GOLD', lot_size: 100, description: 'Gold Mega' },
    { symbol: 'GOLDM', lot_size: 10, description: 'Gold Mini' },
    { symbol: 'MGOLD', lot_size: 10, description: 'Gold Mini Alternate' },
    { symbol: 'GOLDGUINEA', lot_size: 8, description: 'Gold Guinea' },
    { symbol: 'GOLDPETAL', lot_size: 1, description: 'Gold Petal' },
    { symbol: 'SILVER', lot_size: 30, description: 'Silver Mega' },
    { symbol: 'SILVERM', lot_size: 5, description: 'Silver Mini' },
    { symbol: 'MSILVER', lot_size: 5, description: 'Silver Mini Alternate' },
    { symbol: 'SILVERMIC', lot_size: 1, description: 'Silver Micro' },
    { symbol: 'COPPER', lot_size: 2500, description: 'Copper Mega' },
    { symbol: 'COPPERM', lot_size: 250, description: 'Copper Mini' },
    { symbol: 'MCOPPER', lot_size: 250, description: 'Copper Mini Alternate' },
    { symbol: 'ZINC', lot_size: 5000, description: 'Zinc Mega' },
    { symbol: 'ZINCMINI', lot_size: 1000, description: 'Zinc Mini' },
    { symbol: 'MZINC', lot_size: 1000, description: 'Zinc Mini Alternate' },
    { symbol: 'LEAD', lot_size: 5000, description: 'Lead Mega' },
    { symbol: 'LEADMINI', lot_size: 1000, description: 'Lead Mini' },
    { symbol: 'MLEAD', lot_size: 1000, description: 'Lead Mini Alternate' },
    { symbol: 'ALUMINIUM', lot_size: 5000, description: 'Aluminium Mega' },
    { symbol: 'ALUMINI', lot_size: 1000, description: 'Aluminium Mini' },
    { symbol: 'MALUMINIUM', lot_size: 1000, description: 'Aluminium Mini Alternate' },
    { symbol: 'NICKEL', lot_size: 1500, description: 'Nickel Mega' },
    { symbol: 'NICKELMINI', lot_size: 100, description: 'Nickel Mini' },
    { symbol: 'MENTHAOIL', lot_size: 360, description: 'Mentha Oil' },
    { symbol: 'COTTON', lot_size: 25, description: 'Cotton' },
    { symbol: 'COTTONCNDY', lot_size: 20, description: 'Cotton Candy' },
    { symbol: 'BULLDEX', lot_size: 1, description: 'Bulldex Index' }
];

async function initMcxLotSizesTable() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS mcx_lot_sizes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                symbol VARCHAR(50) UNIQUE NOT NULL,
                lot_size INT NOT NULL,
                description VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // Check if table is empty
        const [rows] = await db.execute('SELECT COUNT(*) as cnt FROM mcx_lot_sizes');
        if (rows[0].cnt === 0) {
            console.log('📦 [MCX Model] Seeding initial MCX lot sizes into mcx_lot_sizes table...');
            for (const item of INITIAL_MCX_LOT_SIZES) {
                await db.execute(
                    'INSERT IGNORE INTO mcx_lot_sizes (symbol, lot_size, description) VALUES (?, ?, ?)',
                    [item.symbol, item.lot_size, item.description]
                );
            }
            console.log(`✅ [MCX Model] Seeded ${INITIAL_MCX_LOT_SIZES.length} MCX lot sizes.`);
        }
    } catch (err) {
        console.error('❌ [MCX Model] Error initializing mcx_lot_sizes table:', err.message);
    }
}

async function getAllMcxLotSizesFromDb() {
    try {
        const [rows] = await db.execute('SELECT symbol, lot_size, description FROM mcx_lot_sizes');
        const map = {};
        for (const row of rows) {
            map[row.symbol.toUpperCase()] = parseInt(row.lot_size);
        }
        return map;
    } catch (err) {
        console.error('❌ [MCX Model] Error fetching lot sizes from DB:', err.message);
        return null;
    }
}

async function updateMcxLotSizeInDb(symbol, lotSize, description = null) {
    try {
        const sym = symbol.toUpperCase();
        const size = parseInt(lotSize);
        await db.execute(
            `INSERT INTO mcx_lot_sizes (symbol, lot_size, description) 
             VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), description = COALESCE(VALUES(description), description)`,
            [sym, size, description]
        );
        return true;
    } catch (err) {
        console.error('❌ [MCX Model] Error updating MCX lot size in DB:', err.message);
        return false;
    }
}

module.exports = {
    initMcxLotSizesTable,
    getAllMcxLotSizesFromDb,
    updateMcxLotSizeInDb,
    INITIAL_MCX_LOT_SIZES
};
