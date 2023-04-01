const Watchdog = require('event-watchdog');

const watchdog = new Watchdog(parseInt(process.env.watchdog_timeout, 10), 1, (function (){if( process.env.DEBUG === 'true' || process.env.DEBUG === true) {return true;} else {return false;}})());

watchdog.on('timeout', (data) => {
    process.log.error(data);
    process.exit(1);
});

module.exports = watchdog;