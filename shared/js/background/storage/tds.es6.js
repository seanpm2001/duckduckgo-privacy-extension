const load = require('./../load.es6')
const Dexie = require('dexie')
const constants = require('../../../data/constants')
const settings = require('./../settings.es6')
const browserWrapper = require('./../$BROWSER-wrapper.es6')
const MIN_UPDATE_TIME = 30 * 60 * 1000 // 30min

class TDSStorage {
    constructor () {
        this.dbc = new Dexie('tdsStorage')
        this.dbc.version(1).stores({
            tdsStorage: 'name,data'
        })
        this.tds = {entities: {}, trackers: {}, domains: {}}
        this.surrogates = ''
        this.brokenSiteList = []
    }

    getLists () {
        return Promise.all(constants.tdsLists.map(list => {
            const listCopy = JSON.parse(JSON.stringify(list))
            const etag = settings.getSetting(`${listCopy.name}-etag`) || ''
            const lastUpdate = settings.getSetting(`${listCopy.name}-last-update`) || ''
            const version = this.getVersionParam()

            // if we have a copy of that list and it was recently updated, don't try to update it
            if (etag && Date.now() - lastUpdate < MIN_UPDATE_TIME) {
                console.warn(`Skipping update of "${listCopy.name}" as it was recently updated.`)
                return this.getListFromDB(listCopy.name)
            }

            if (version) {
                listCopy.url += version
            }

            return this.getDataXHR(listCopy, etag).then(response => {
                // for 200 response we update etags
                if (response && response.status === 200) {
                    const newEtag = response.etag || ''
                    settings.updateSetting(`${listCopy.name}-etag`, newEtag)
                }

                if (response && (response.status === 200 || response.status === 304)) {
                    settings.updateSetting(`${listCopy.name}-last-update`, Date.now())
                }

                // We try to process both 200 and 304 responses. 200s will validate
                // and update the db. 304s will try to grab the previous data from db
                // or throw an error if none exists.
                return this.processData(listCopy.name, response.data).then(resultData => {
                    if (resultData) {
                        // store tds in memory so we can access it later if needed
                        this[listCopy.name] = resultData
                        return {name: listCopy.name, data: resultData}
                    } else {
                        throw new Error(`TDS: process list xhr failed`)
                    }
                })
            }).catch(e => this.getListFromDB(listCopy.name))
        }))
    }

    getListFromDB (listName) {
        return this.fallbackToDB(listName).then(backupFromDB => {
            if (backupFromDB) {
                // store tds in memory so we can access it later if needed
                this[listName] = backupFromDB
                return {name: listName, data: backupFromDB}
            } else {
                // reset etag to force us to get fresh server data in case of an error
                settings.updateSetting(`${listName}-etag`, '')
                settings.updateSetting(`${listName}-last-update`, 0)
                throw new Error(`TDS: data update failed`)
            }
        })
    }

    processData (name, xhrData) {
        if (xhrData) {
            const parsedData = this.parsedata(name, xhrData)
            this.storeInLocalDB(name, parsedData)
            return Promise.resolve(parsedData)
        } else {
            return Promise.resolve()
        }
    }

    fallbackToDB (name) {
        return this.getDataFromLocalDB(name).then(storedData => {
            if (!storedData) return

            if (storedData && storedData.data) {
                return storedData.data
            }
        })
    }

    getDataXHR (list, etag) {
        return load.loadExtensionFile({url: list.url, etag: etag, returnType: list.format, source: 'external', timeout: 60000})
    }

    getDataFromLocalDB (name) {
        console.log('TDS: getting from db')
        return this.dbc.open()
            .then(() => this.dbc.table('tdsStorage').get({name: name}))
    }

    storeInLocalDB (name, data) {
        return this.dbc.tdsStorage.put({name: name, data: data})
    }

    parsedata (name, data) {
        const parsers = {
            'brokenSiteList': data => {
                return data.split('\n')
            }
        }

        if (parsers[name]) {
            return parsers[name](data)
        } else {
            return data
        }
    }

    // add version param to url on the first install and only once a day after that
    getVersionParam () {
        const ONEDAY = 1000 * 60 * 60 * 24
        const version = browserWrapper.getExtensionVersion()
        const lastTdsUpdate = settings.getSetting('lastTdsUpdate')
        const now = Date.now()
        let versionParam

        // check delta for last update
        if (lastTdsUpdate) {
            const delta = now - new Date(lastTdsUpdate)

            if (delta > ONEDAY) {
                versionParam = `&v=${version}`
            }
        } else {
            versionParam = `&v=${version}`
        }

        if (versionParam) settings.updateSetting('lastTdsUpdate', now)

        return versionParam
    }
}
module.exports = new TDSStorage()
