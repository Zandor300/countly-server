const plugins = require('../../../../pluginManager.js');
const common = require('../../../../../api/utils/common.js');
const utils = require('../../utils.js');
const log = common.log("hooks:api:schedule");
const JOB = require('../../../../../api/parts/jobs');
const later = require('later');
const moment = require('moment-timezone');

/**
 * Scheduled trigger
 */
class ScheduledTrigger {
    /**
     * Init variables
     * @param {object} options - config options
     * @param {object} options.pipeline -pipeline instance inited by Hooks class
     */
    constructor(options) {
        this._rules = options.rules || [];
        this.pipeline = options.pipeline || (() => {});
        this.register();
    }

    /**
     * syncRules with hook module periodically, filter related hooks
     * @param {Array} rules - hook record objects array
     */
    syncRules(rules) {
        if (rules instanceof Array) {
            const newRules = rules.filter(r => {
                return r.trigger.type === 'ScheduledTrigger';
            });
            this._rules = newRules;
        }
    }

    /**
     * process pipeline feed, pick out matched record with rule
     * @param {object} ob - trggered out from pipeline
     */
    async process(ob) {
        log.d(JSON.stringify(ob), "[hook trigger schedule]");
        const {rule} = ob;
        if (!rule) {
            return false;
        }
        if (ob.is_mock === true) {
            return ob;
        }

        utils.updateRuleTriggerTime(rule._id);
        // send to pipeline
        const data = {
            rule: rule,
        };
        this.pipeline(data);
        return data;
    }

    /**
     * register trigger processor
     */
    register() {
        plugins.register("/hooks/schedule", () => {
            log.d("[hooks schedule triggered]");
            this._rules.forEach(r => {
                var sched = later.parse.cron(r.trigger.configuration.cron);
                var nextTime = later.schedule(sched).next(1);
                const expectedTime = new moment(nextTime);
                const serverTime = new moment(new Date()).tz(r.trigger.configuration.timezone2);
                log.d("[hooks schedule check]", nextTime, expectedTime, serverTime, r);

                if (expectedTime.year() === serverTime.year() &&
                    expectedTime.month() === serverTime.month() &&
                    expectedTime.date() === serverTime.date() &&
                    expectedTime.hour() === serverTime.hour()) {
                    this.process({rule: r});
                    log.d("[hooks schedule check matched]", expectedTime, serverTime, r);
                }
            });
            return true;
        });
    }
}


plugins.register("/master", function() {
    JOB.job('hooks:schedule', {type: 'ScheduledTrigger'}).replace().schedule("every 1 hour on the 1st min");
});


module.exports = ScheduledTrigger;
