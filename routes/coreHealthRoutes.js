const express = require('express');
const roleCoreManager = require('../modules/roleCoreManager');

module.exports = function createCoreHealthRoutes() {
    const router = express.Router();

    router.get('/health', async (_req, res) => {
        try {
            const roles = await roleCoreManager.listRoles();
            res.json({
                ok: true,
                service: 'vcp-role-core',
                role_count: roles.length
            });
        } catch (error) {
            res.status(500).json({
                ok: false,
                error: error.message
            });
        }
    });

    return router;
};
