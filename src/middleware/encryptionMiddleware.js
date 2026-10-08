const { encryptData } = require('../utils/encryption');

const encryptionMiddleware = (req, res, next) => {
    // We only encrypt responses when enabled (default true)
    const ENABLE_ENCRYPTION = process.env.ENABLE_ENCRYPTION !== 'false'; 

    if (ENABLE_ENCRYPTION) {
        const originalJson = res.json;
        
        res.json = function (data) {
            // Intercept and encrypt the data
            if (data && !data._isEncrypted) {
                const encryptedPayload = encryptData(data);
                if (encryptedPayload) {
                    // Send encrypted payload inside a specific structure
                    return originalJson.call(this, { 
                        _encrypted: true, 
                        payload: encryptedPayload 
                    });
                }
            }
            // Fallback to original data if encryption fails or is bypassed
            return originalJson.call(this, data);
        };
    }
    
    next();
};

module.exports = encryptionMiddleware;
