const express = require('express');
const roleTurnService = require('../modules/roleTurnService');

module.exports = function createCoreTurnsRoutes() {
    const router = express.Router();

    router.post('/role-turn', async (req, res) => {
        try {
            const result = await roleTurnService.execute(req.body || {});
            res.json(result);
        } catch (error) {
            res.status(error.status || 500).json({
                error: error.message,
                details: error.payload || null
            });
        }
    });

    return router;
};
