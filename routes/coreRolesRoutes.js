const express = require('express');
const roleCoreManager = require('../modules/roleCoreManager');

module.exports = function createCoreRolesRoutes() {
    const router = express.Router();

    router.get('/roles', async (req, res) => {
        try {
            const search = (req.query.q || '').trim().toLowerCase();
            const roles = await roleCoreManager.listRoles();
            const filteredRoles = search
                ? roles.filter(role => {
                    const haystack = [
                        role.id,
                        role.name,
                        role.source,
                        role.tag,
                        role.persona
                    ].join(' ').toLowerCase();
                    return haystack.includes(search);
                })
                : roles;

            res.json({
                roles: filteredRoles
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.get('/roles/:id', async (req, res) => {
        try {
            const role = await roleCoreManager.getRoleById(req.params.id);
            if (!role) {
                return res.status(404).json({ error: 'role not found' });
            }

            res.json({ role });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/roles/import', async (req, res) => {
        try {
            const importedRole = await roleCoreManager.importRole(req.body || {});
            res.status(201).json({ role: importedRole });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    return router;
};
