require('dotenv').config();
require('module-alias/register')

const port = process.env.PORT || 80;
//This timeout is used to delay accepting connections until the server is fully loaded. 
//It could come to a crash if a request comes in before the settings cache was fully laoded.

const { log } = require('@lib/logger');

const fs = require('fs');

process.log = {};
process.log = log;

// Render Templates
const path = require('path');
const { renderEJSToPublic } = require('@lib/template');
/* Load some config data, thats needed to render the HTML pages on startup */
// Get all translation files from \public\dist\locales and generate a context object ({ [language]: [file key.language] })
const localesDir = path.join(__dirname, 'public', 'dist', 'locales');
let countryConfig = {};
const files = fs.readdirSync(localesDir);

files.forEach(file => {
    if (file.endsWith('.json')) {
        let langCode = file.split('.')[0];
        let filePath = path.join(localesDir, file);
        let fileContents = fs.readFileSync(filePath, 'utf8');
        let jsonData = JSON.parse(fileContents);
        if (jsonData[langCode]) {
            countryConfig[langCode] = jsonData[langCode];
        }
    }
});

renderEJSToPublic(path.join(__dirname, 'views'), path.join(__dirname, 'public'), ["error-xxx.ejs", "landingpage.ejs"]);

(async () => {
    const { ObjectStore } = require('@lib/haltestellen_cache');
    const { createTables, haltestellen } = require('@lib/postgres');
    try {
        await createTables();
        await ObjectStore.init()
        const haltestellen_data = await ObjectStore.getKeysAmount();
        haltestellen_data.forEach(async (haltestelle) => {
            const { Haltestellenname, VAGKennung, VGNKennung, Longitude, Latitude, Produkte } = ObjectStore.get(haltestelle);
            await haltestellen.insertOrUpdate(VGNKennung, VAGKennung, Haltestellenname, Latitude, Longitude, Produkte);
        });
    } catch (error) {
        process.log.error(`Failed to create tables: ${error}`);
        process.exit(1);
    }

    setTimeout(() => {
        const app = require('@src/app');

        setTimeout(() => {
            if (process.env.ExtraErrorWebDelay > 0) {
                process.log.system(`Webserver was delayed by ${process.env.ExtraErrorWebDelay || 500}ms beause of a error.`);
            }
            app.listen(port)
                .then((socket) => process.log.system(`Listening on port: ${port}`))
                .catch((error) => process.log.error(`Failed to start webserver on: ${port}\nError: ${error}`));
        }, 1500);
    }, process.env.GlobalWaitTime || 100);
})();