const { openvgn } = require('oepnv-nuremberg');

const vgn = new openvgn();

const Redis = require('ioredis');
const { Worker } = require('bullmq');

const { getLastStopAndProgress, removeDuplicatesAndKeepOrder } = require('@lib/util');
const { writeNewDatapoint, ScheduleJob, delTripKey, errorExporter, addTripLocation } = require('@lib/redis');

const { insertOrUpdateFahrtEntry, insertOrUpdateHaltestelle } = require('@lib/postgres');

const queueData = {
    port: process.env.Redis_Port || 6379,
    host: process.env.Redis_Host || "127.0.0.1",
    username: process.env.Redis_User || "default",
    password: process.env.Redis_Password || "default",
    db: process.env.Redis_DB + 1 || 1,
}

new Worker('q:trips', async (job) => {
    try {
        const { Fahrtnummer, Betriebstag, Produkt, AlreadyTrackedStops, Startzeit, Endzeit } = job.data;

        const tripData = await vgn.getTrip(Fahrtnummer, { product: Produkt, date: Betriebstag })

        const { Fahrt, Meta } = tripData;
        const { Linienname, Fahrzeugnummer, Besetzgrad, Richtung, Richtungstext, Fahrtverlauf } = Fahrt;

        writeNewDatapoint('METRICLIST:Trip.RequestTime', Meta.RequestTime); // Store the request time for later analysis

        const currentTime = new Date();
        const Fahrtverlauf_result = getLastStopAndProgress(Fahrtverlauf, currentTime);
        const unProcessedStopsList = removeDuplicatesAndKeepOrder(Fahrtverlauf_result.vgnCodes, AlreadyTrackedStops); // All those stops we need to write to db

        const dbInsertPromises = unProcessedStopsList.map((stop) => {
            const stopObject = Fahrtverlauf.find((obj) => obj.VGNKennung === stop);
            process.log.warn(`Inserting fahrt ${Fahrtnummer} (${Produkt}) stop ${stopObject.Haltestellenname} into the database...`);
            const AnkunftszeitVerspätung = stopObject.AnkunftszeitIst ? Math.floor((new Date(stopObject.AnkunftszeitIst) - new Date(stopObject.AnkunftszeitSoll)) / 1000) : 0;
            const AbfahrtszeitVerspätung = stopObject.AbfahrtszeitIst ? Math.floor((new Date(stopObject.AbfahrtszeitIst) - new Date(stopObject.AbfahrtszeitSoll)) / 1000) : 0;
            return insertOrUpdateFahrtEntry(Fahrtnummer, Betriebstag, Produkt, stopObject.VGNKennung, stopObject.Haltepunkt, stopObject.Richtungstext, stopObject.AnkunftszeitSoll, AnkunftszeitVerspätung, stopObject.AbfahrtszeitSoll, AbfahrtszeitVerspätung);
        });

        const insertResult = await Promise.allSettled(dbInsertPromises);
        for (const result of insertResult) {
            if (result.status === 'rejected') {
                if (result.reason.code === '23503') {
                    try {
                        // GANZ EHRLICH WAS IST FUCKING FALSCH MIT EUCH? DAS IST JA ABRARTIG PEINLICH
                        // Because the DB is kinda... normalized, there are some cases where a fahrt stops at stops not existing. Nice, isn´t it?
                        // Thats why we add all stops missing in /haltestellen here... 
                        const resultIndex = insertResult.indexOf(result);
                        const stopObject = Fahrtverlauf.find((obj) => obj.VGNKennung === unProcessedStopsList[resultIndex]);
                        process.log.warn(`Could not find stop ${stopObject.VGNKennung} in the database, trying to insert it now...`);
                        await insertOrUpdateHaltestelle(stopObject.VGNKennung, stopObject.VAGKennung, stopObject.Haltestellenname, stopObject.Latitude, stopObject.Longitude, Produkt);
                        // Insert the trip again... now that we actualy HAVE it.
                        const AnkunftszeitVerspätung = stopObject.AnkunftszeitIst ? Math.floor((new Date(stopObject.AnkunftszeitIst) - new Date(stopObject.AnkunftszeitSoll)) / 1000) : 0;
                        const AbfahrtszeitVerspätung = stopObject.AbfahrtszeitIst ? Math.floor((new Date(stopObject.AbfahrtszeitIst) - new Date(stopObject.AbfahrtszeitSoll)) / 1000) : 0;
                        await insertOrUpdateFahrtEntry(Fahrtnummer, Betriebstag, Produkt, stopObject.VGNKennung, stopObject.Haltepunkt, stopObject.Richtungstext, stopObject.AnkunftszeitSoll, AnkunftszeitVerspätung, stopObject.AbfahrtszeitSoll, AbfahrtszeitVerspätung);
                        continue;
                    } catch (error) {
                        errorExporter(error, error, job.data);
                        throw new Error(error);
                    }
                }
                errorExporter(result.reason, result, job.data);
                throw new Error(result.reason);
            }
        }

        // Check if there is a next stop or not
        if (Fahrtverlauf_result.lastStopIndex === Fahrtverlauf_result.length - 1) {
            delTripKey(Fahrtnummer); // We are done with this trip
            return;
        }

        const lastStopObject = Fahrtverlauf[Fahrtverlauf_result.lastStopIndex];
        const nextStopObject = Fahrtverlauf[Fahrtverlauf_result.lastStopIndex + 1];

        if (Fahrtverlauf_result.lastStopIndex === -1) {
            throw new Error(`Could not find last stop for ${Fahrtnummer} (${Produkt})`);
        }

        const tripKeyData = {
            VGNKennung: lastStopObject.VGNKennung,
            VAGKennung: lastStopObject.VAGKennung,
            Produkt: Produkt,
            Linienname: Linienname,
            Richtung: Richtung,
            Richtungstext: Richtungstext,
            Fahrzeugnummer: Fahrzeugnummer,
            Betriebstag: Betriebstag,
            Besetzgrad: Besetzgrad,
            Haltepunkt: lastStopObject.Haltepunkt,
            AbfahrtszeitSoll: lastStopObject.AbfahrtszeitSoll,
            AbfahrtszeitIst: lastStopObject.AbfahrtszeitIst,
            PercentageToNextStop: Fahrtverlauf_result.progress,
        }

        addTripLocation(lastStopObject.VGNKennung, lastStopObject.Latitude, lastStopObject.Longitude);

        const nextRunAt = new Date(nextStopObject.AnkunftszeitIst).getTime() + 5000 // experimental

        process.log.info(`Processed [${Fahrtnummer}] ${Produkt} (${Linienname}) [${new Date(lastStopObject.AbfahrtszeitIst).toLocaleTimeString()}] ${lastStopObject.Haltestellenname} Next stop: ${nextStopObject.Haltestellenname} [${new Date(nextStopObject.AnkunftszeitIst).toLocaleTimeString()}] Progress: ${Fahrtverlauf_result.progress}`);
        await ScheduleJob(Fahrtnummer, Betriebstag, Produkt, tripKeyData, Fahrtverlauf_result.vgnCodes, nextRunAt, Startzeit, Endzeit);

    } catch (error) {

        console.log(error);
        throw error;
    }
}, {
    connection: queueData,
    removeOnComplete: { count: 1 },
    removeOnFail: { count: 50 },
    concurrency: 5
});