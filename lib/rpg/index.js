const models = require('./models');
const economyFoundation = require('./economyFoundation');
const localizationService = require('./localizationService');
const auditService = require('./auditService');
const guildService = require('./guildService');
const questService = require('./questService');
const marketService = require('./marketService');
const inventoryService = require('./inventoryService');
const combatService = require('./combatService');

module.exports = {
    ...models,
    ...economyFoundation,
    ...localizationService,
    ...auditService,
    ...guildService,
    ...questService,
    ...marketService,
    ...inventoryService,
    ...combatService
};
