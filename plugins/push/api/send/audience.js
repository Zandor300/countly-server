const common = require('../../../../api/utils/common'),
    { PushError, ERROR } = require('./data/error'),
    { State, TriggerKind } = require('./data'),
    { DEFAULTS } = require('./data/const'),
    { PLATFORM } = require('./platforms'),
    { Push } = require('./data/message'),
    { fields, TK } = require('./platforms'),
    momenttz = require('moment-timezone'),

    /**
     * Get Drill plugin api
     * 
     * @returns {object} drill api 
     */
    drill = () => {
        if (typeof global.it === 'function') {
            try {
                return require('../../../drill/api');
            }
            catch (e) {
                return undefined;
            }
        }
        else {
            return require('../../../pluginManager').getPluginsApis().drill;
        }
    },
    /**
     * Get Geolocations plugin api
     * 
     * @returns {object} geo api 
     */
    geo = () => {
        if (typeof global.it === 'function') {
            try {
                return require('../../../geo/api');
            }
            catch (e) {
                return undefined;
            }
        }
        else {
            return require('../../../pluginManager').getPluginsApis().geo;
        }
    };

/**
 * Class encapsulating user selection / queue / message scheduling logic
 */
class Audience {
    /**
     * Constructor
     * 
     * @param {logger} log parent logger
     * @param {Message} message message instance
     * @param {Object|undefined} app app object
     */
    constructor(log, message, app = undefined) {
        this.log = log.sub('audience');
        this.message = message;
        this.app = app;
    }

    /**
     * Lazy load app from db
     * 
     * @returns {object} app object
     */
    async getApp() {
        if (!this.app) {
            this.app = await common.db.collection('apps').findOne(this.message.app);
            if (!this.app) {
                throw new PushError(`App ${this.message.app} not found`, ERROR.EXCEPTION);
            }
        }
        return this.app;
    }

    /**
     * Create new Pusher
     * 
     * @param {Trigger} trigger effective trigger
     * @returns {Pusher} pusher instance bound to this audience
     */
    push(trigger) {
        return new Pusher(this, trigger);
    }

    /**
     * Create new Popper
     * 
     * @param {Trigger} trigger effective trigger
     * @returns {Popper} popper instance bound to this audience
     */
    pop(trigger) {
        return new Popper(this, trigger);
    }

    /**
     * Create new SchedulePusher
     * 
     * @param {Trigger} trigger effective trigger
     * @param {Date} date override
     * @returns {SchedulePusher} popper instance bound to this audience
     */
    schedule(trigger, date) {
        return new SchedulePusher(this, trigger).setStart(date);
    }

    // /**
    //  * Find users defined by message filter and put corresponding records into queue
    //  * 
    //  * @param {Message} message message to schedule
    //  */
    // static schedule(message) {
    //     for (let pi = 0; pi < message.platforms.length; pi++) {
    //         let p = message.platforms[pi];
    //     }
    // }

    /**
     * Construct an aggregation query for app_users collection from message Filter
     * 
     * @param {object} project app_users projection
     * @returns {object[]} array of aggregation pipeline steps
     */
    async steps(project = {uid: 1}) {
        let flds = fields(this.message.platforms, true).map(f => ({[f]: true})),
            steps = [];

        // We have a token
        steps.push({$match: {$or: flds}});

        // Geos
        if (this.message.filter.geos.length && geo()) {
            let geos = await common.db.collection('geos').find({_id: {$in: this.message.filter.geos}}).toArray();
            steps.push({$match: {$or: geos.map(g => geo().conds(g))}});
        }

        // Cohorts
        if (this.message.filter.cohorts.length) {
            let chr = {};
            this.message.filter.cohorts.forEach(id => {
                chr[`chr.${id}.in`] = 'true';
            });
            steps.push({$match: chr});
        }

        // User query
        if (this.message.filter.user) {
            let query = this.message.filter.user;

            if (query.message) {
                let filtered = await this.filterMessage(query.message);
                delete query.message;

                steps.push({$match: {uid: {$in: filtered}}});
            }

            if (query.geo) {
                if (drill() && geo()) {
                    drill().preprocessQuery(query);
                    let geos = await geo().query(this.app._id, query.geo);
                    if (geos && geos.length) {
                        steps.push({$match: {$or: geos.map(g => geo().conds(g))}});
                    }
                    else {
                        query.invalidgeo = true;
                    }
                }
                delete query.geo;
            }

            if (Object.keys(query).length) {
                steps.push({$match: query});
            }
        }

        // Drill query
        if (this.message.filter.drill && drill()) {
            let query = this.message.filter.drill;

            if (query.queryObject && query.queryObject.chr && Object.keys(query.queryObject).length === 1) {
                let cohorts = {}, chr = query.queryObject.chr, i;

                if (chr.$in && chr.$in.length) {
                    for (i = 0; i < chr.$in.length; i++) {
                        cohorts['chr.' + chr.$in[i] + '.in'] = 'true';
                    }
                }
                if (chr.$nin && chr.$nin.length) {
                    for (i = 0; i < chr.$nin.length; i++) {
                        cohorts['chr.' + chr.$nin[i] + '.in'] = {$exists: false};
                    }
                }

                steps.push({$match: cohorts});
            }
            else {
                // drill().drill.openDrillDb();

                var params = {
                    time: common.initTimeObj(this.app.timezone, Date.now()),
                    qstring: Object.assign({app_id: this.app._id.toString()}, query)
                };
                delete params.qstring.queryObject.chr;

                this.log.d('Drilling: %j', params);
                let arr = await new Promise((resolve, reject) => drill().drill.fetchUsers(params, (err, uids) => {
                    this.log.i('Done drilling: %j ' + (err ? 'error %j' : '%d uids'), err || (uids && uids.length) || 0);
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(uids || []);
                    }
                }, common.db));

                steps.push({$match: {uid: {$in: arr}}});
            }
        }

        steps.push({$project: project});

        this.log.d('steps: %j', steps);

        // TODO: add steps optimisation (i.e. merge uid: $in)

        return steps;
    }

    /**
     * Construct an aggregation query for app_users collection from message Filter
     * 
     * @param {object} project app_users projection
     * @returns {object[]} array of app_users documents
     */
    async aggregate(project = {uid: 1}) {
        let steps = await this.query(project);
        return await common.db.collection(`app_users${this.app._id}`).aggregate(steps).toArray();
    }


    /**
     * Get uids by message $in
     * 
     * @param  {Object} min filter condition: [oid], {$in: [oid]}, {$nin: [oid]}
     * @return {Promise}    resoves to array of uids
     */
    async filterMessage(min) {
        let query = (min.$in || min.$nin) ? min : {$in: min};
        if (min.$in) {
            min.$in = min.$in.map(this.db.ObjectID);
        }
        if (min.$nin) {
            min.$nin = min.$nin.map(this.db.ObjectID);
        }
        if (min.$nin) {
            query = {
                $or: [
                    {msgs: {$elemMatch: {'0': query}}},
                    {msgs: {$exists: false}},
                ]
            };
        }
        else {
            query = {msgs: {$elemMatch: {'0': query}}};
        }
        return await common.db.collection(`push_${this.app._id}`).find(query, {projection: {_id: 1}}).toArray();
    }
}

/**
 * Base Mapper
 * 
 * ... using classes here to quit from lots and lots of conditionals in favor of quite simple hierarchical logic
 */
class Mapper {
    /**
     * Constructor
     * 
     * @param {object} app app
     * @param {Message} message message
     * @param {Trigger} trigger trigger
     * @param {string} p platform key
     * @param {string} f field key
     */
    constructor(app, message, trigger, p, f) {
        this.offset = momenttz.tz(app.timezone).utcOffset();
        this.message = message;
        this.trigger = trigger;
        this.p = p;
        this.f = f;
        this.pf = p + f;
        this.userFields = message.userFields;
    }

    /**
     * Set sending date addition in ms for rate limiting
     * 
     * @param {number} addition sending date addition in ms
     * @returns {Mapper} this instance for method chaining
     */
    setAddition(addition) {
        this.addition = addition;
        return this;
    }

    /**
     * Map app_user object to message
     * 
     * @param {object} user app_user object
     * @param {number} date notification date as ms timestamp
     * @param {object} pr user props object
     * @param {object[]} c [Content.json] overrides
     * @returns {object} push object ready to be inserted
     */
    map(user, date, pr, c) {
        let ret = {
            _id: common.db.oidWithDate(date),
            m: this.message._id,
            p: this.p,
            f: this.f,
            u: user.uid,
            t: user[TK][this.pf],
            pr
        };
        if (c) {
            ret.c = c;
        }
        return c;
    }
}

/**
 * Plain or API triggers mapper - uses date calculation logic for those cases
 */
class PlainApiMapper extends Mapper {
    /**
     * Map app_user object to message
     * 
     * @param {object} user app_user object
     * @param {Date} date notification date
     * @param {object[]} c [Content.json] overrides
     * @returns {object} push object ready to be inserted
     */
    map(user, date, c) {
        let d = date.getTime();
        if (this.trigger.tz) {
            let utz = (user.tz === undefined || user.tz === null ? this.offset || 0 : user.tz || 0) * 60000;
            d = date.getTime() - this.trigger.sctz * 60000 - utz;
        }
        return super.map(user, d, c);
    }
}

/**
 * Plain or API triggers mapper - uses date calculation logic for those cases
 */
class CohortsEventsMapper extends Mapper {
    /**
     * Map app_user object to message
     * 
     * @param {object} user app_user object
     * @param {Date} date reference date (cohort entry date, event date)
     * @param {object[]} c [Content.json] overrides
     * @returns {object} push object ready to be inserted
     */
    map(user, date, c) {
        let d = date.getTime();

        // send in user's timezone
        if (this.trigger.time !== null && this.trigger.time !== undefined) {
            let utz = (user.tz === undefined || user.tz === null ? this.offset || 0 : user.tz || 0) * 60000,
                auto = new Date(d),
                inTz;

            auto.setHours(0);
            auto.setMinutes(0);
            auto.setSeconds(0);
            auto.setMilliseconds(0);

            inTz = auto.getTime() + this.trigger.time + (new Date().getTimezoneOffset() || 0) * 60000 - utz;
            if (inTz < Date.now()) {
                if (this.trigger.reschedule) {
                    d = inTz + 24 * 60 * 60000;
                }
                else {
                    return null;
                }
            }
            else {
                d = inTz;
            }
        }

        // delayed message to spread the load across time
        if (this.trigger.delay) {
            d += this.trigger.delay;
        }

        // trigger end date is before the date we have, we can't send this
        if (this.trigger.end && this.trigger.end.getTime() < d) {
            return null;
        }

        return super.map(user, d, c);
    }
}

/**
 * Pushing / popping notes to queue logic
 */
class PusherPopper {
    /**
     * Constructor
     * @param {Audience} audience audience object
     * @param {Trigger} trigger trigger object
     */
    constructor(audience, trigger) {
        this.audience = audience;
        this.trigger = trigger;
        this.mappers = this.audience.message.platforms.map(p => {
            return Object.values(PLATFORM[p].FIELDS).map(f => {
                if (trigger.kind === TriggerKind.API || trigger.kind === TriggerKind.Plain) {
                    return new PlainApiMapper(audience.app, audience.message, trigger, p, f);
                }
                else {
                    return new CohortsEventsMapper(audience.app, audience.message, trigger, p, f);
                }
            });
        }).flat();
        // this.date = {
        //     [Trigger]: this.datathis.audience.message.triggerFind(t => t.kind === TriggerKind.API || t.kind === TriggerKind.Plain) ? this.datePlainAPI.bind(this) : this.dateCohortsEvents.bind(this);
    }

    /**
     * Set contents overrides
     * 
     * @param {Content[]} contents notification data
     * @returns {Pusher} this instance for easy method chaining
     */
    setContents(contents) {
        this.contents = contents;
        return this;
    }

    /**
     * Set custom data
     * 
     * @param {Object} data notification data
     * @returns {Pusher} this instance for easy method chaining
     */
    setData(data) {
        this.data = data;
        return this;
    }

    /**
     * Set custom variables
     * 
     * @param {Object} variables notification variables
     * @returns {Pusher} this instance for easy method chaining
     */
    setVariables(variables) {
        this.variables = variables;
        return this;
    }

    /**
     * Set start
     * 
     * @param {Date} start start of the notification
     * @returns {Pusher} this instance for easy method chaining
     */
    setStart(start) {
        this.start = start;
        return this;
    }

    /**
     * Set user uids
     * 
     * @param {string[]} uids array of uids
     * @returns {Pusher} this instance for easy method chaining
     */
    setUIDs(uids) {
        this.uids = uids;
        return this;
    }

    /**
     * Do the thing
     */
    async run() {
        throw new Error('Must be overridden');
    }
}

/**
 * Scheduler, that is pusher for all notes given message filter
 */
class SchedulePusher extends PusherPopper {
    /**
     * Insert records into db
     */
    async run() {
        this.audience.log.f('d', log => log('scheduling %s date %s data %j', this.audience.message._id, this.date ? this.date : '', this.data ? this.data : ''),
            'i', 'scheduling %s', this.audience.message._id);

        let batchSize = DEFAULTS.queue_insert_batch,
            steps = await this.audience.steps(this.audience.message.userFields),
            stream = common.db.collection(`app_users${this.audience.app._id}`).aggregate(steps).stream(),
            batch = Push.batchInsert(batchSize),
            start = this.start || this.audience.message.triggerPlain().start; // plain trigger is supposed to be set here as SchedulePusher is only used for plain triggers

        for await (let user of stream) {
            for (let mapper of this.mappers) {
                let push = mapper.map(user, start, this.contents);
                if (!push) {
                    continue;
                }
                if (batch.pushSync(push)) {
                    this.audience.log.d('inserting batch of %d, %d records total', batch.length, batch.total);
                    await batch.flush();
                }
            }
        }

        this.audience.log.d('inserting final batch of %d, %d records total', batch.length, batch.total);
        await batch.flush();
    }
}

/**
 * Pushing notes into queue logic
 */
class Pusher extends PusherPopper {
    /**
     * Insert records into db
     */
    async run() {
        this.audience.log.f('d', log => log('pushing %d uids into %s date %s data %j', this.uids.length, this.audience.message._id, this.date ? this.date : '', this.data ? this.data : '')) ||
            this.audience.log.i('pushing %d uids into %s %s %j', this.uids.length, this.audience.message._id);
    }
}

/**
 * Popping notes from queue logic
 */
class Popper extends PusherPopper {
    /**
     * Remove records from db
     */
    async run() {
        this.audience.log.i('popping %d uids from %s', this.uids.length, this.audience.message._id);
    }

    /**
     * Remove all message pushes
     * 
     * @returns {number} number of records removed
     */
    async clear() {
        let deleted = await Promise.all(this.message.platforms.map(async p => {
            let res = await common.db.collection('push').deleteMany({m: this.message._id, p});
            return res.deletedCount;
        }));
        let update;
        for (let p in deleted) {
            if (!update) {
                update = {$inc: {}};
            }
            update.$inc['result.processed'] = (update.$inc['result.processed'] || 0) + deleted[p];
            update.$inc[`result.errors.${p}.cancelled`] = (update.$inc[`result.errors.${p}.cancelled`] || 0) + deleted[p];
        }
        if (update) {
            await this.message.update(update, () => {
                for (let p in deleted) {
                    this.message.result.processed += deleted[p];
                    this.message.result.response(p, 'cancelled', deleted[p]);
                }
            });
        }
        return Object.values(deleted).reduce((a, b) => a + b, 0);
    }

    /**
     * Remove all message pushes and terminate any processing
     * 
     * @param {string} msg optional error message
     * @returns {number} number of records removed
     */
    async terminate(msg = 'Terminated') {
        let deleted = await this.clear();
        await this.message.update({
            $set: {
                state: State.Done | State.Error,
                'result.error': new PushError(msg).serialize()
            }
        });
        return deleted;
    }

    /**
     * Stop message by moving message pushes to separate collection (so the leftover could be resent)
     */
    async stop() {

    }

    /**
     * Requeue messages in temporary collection to main queue (after stop() call)
     */
    async resend() {

    }
}

module.exports = { Audience };