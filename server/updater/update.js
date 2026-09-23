// Custom data type updater of custom-data-type-iucn.
//
// fylr calls this program for the actions "start_update", "update" and
// "end_update". The request is read from stdin, the response is written to
// stdout. For every entry the updater looks up the current data in the IUCN
// API. It also adds or removes the configured "Red List" tag on the records
// that use the entry.

const http = require("http")
const https = require("https")

const PLUGIN = "custom-data-type-iucn"

// The link separator is used to separate iucn fields from their linked fields.
const LINK_FIELD_SEPARATOR = ":__link:"

// categories that put a species on the red list
const RED_LIST_CATEGORIES = ["EX", "EW", "CR", "EN", "VU"]

// The IUCN API allows 120 requests per minute. The updater needs one request
// per entry, so it waits until an entry took at least this long. 600ms is
// 100 requests per minute, which keeps headroom below the limit.
const MIN_ENTRY_DURATION_MS = 600

// page size of the searches for records to tag
const SEARCH_LIMIT = 1000

// Entries are checked again after this many days when the base config does not
// configure an interval.
const DEFAULT_UPDATE_INTERVAL_DAYS = 90

// Expiry is spread over this many extra days so that entries which were
// updated together do not all expire on the same day.
const EXPIRY_JITTER_DAYS = 6

// ----------------------------------------------------------------- transport

// Performs a request and returns the parsed JSON body.
function request(options) {
    const url = new URL(options.url)
    const client = url.protocol === "https:" ? https : http
    const body = options.body === undefined ? null : JSON.stringify(options.body)

    const headers = Object.assign({}, options.headers)
    if (body !== null) {
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = Buffer.byteLength(body)
    }

    return new Promise((resolve, reject) => {
        const req = client.request(url, { method: options.method || "GET", headers }, (res) => {
            let data = ""
            res.setEncoding("utf8")
            res.on("data", (chunk) => (data += chunk))
            res.on("end", () => {
                if (options.notFoundIsEmpty && res.statusCode === 404) {
                    resolve({})
                    return
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`${options.method || "GET"} ${url.pathname} answered ${res.statusCode}: ${data}`))
                    return
                }
                if (data === "") {
                    resolve({})
                    return
                }
                try {
                    resolve(JSON.parse(data))
                } catch (e) {
                    reject(new Error(`could not parse the response of ${url.pathname}: ${e}`))
                }
            })
        })
        req.on("error", reject)
        if (body !== null) {
            req.write(body)
        }
        req.end()
    })
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// ------------------------------------------------------------------ IUCN API

class IUCNApi {
    constructor(settings) {
        if (!settings || !settings.api_url || !settings.api_token) {
            throw new Error("iucn_api_settings are not configured")
        }
        this.url = settings.api_url.replace(/\/+$/, "")
        this.token = settings.api_token
    }

    get(path) {
        return request({
            url: this.url + path,
            // when a search finds no result, the API v4 answers with 404
            notFoundIsEmpty: true,
            headers: {
                Authorization: this.token,
            },
        })
    }

    searchBySisTaxonId(sisTaxonId) {
        return this.get("/taxa/sis/" + encodeURIComponent(sisTaxonId))
    }

    searchByTaxonname(genus, species) {
        return this.get(
            "/taxa/scientific_name?genus_name=" + encodeURIComponent(genus) + "&species_name=" + encodeURIComponent(species)
        )
    }
}

// Returns the latest assessment of a taxon result, null if there is none.
function getLatestAssessment(data) {
    if (!data || !Array.isArray(data.assessments)) {
        return null
    }
    for (const assessment of data.assessments) {
        if (assessment.latest) {
            return assessment
        }
    }
    return null
}

// Builds the custom data of an entry from a taxon result.
function toObjectData(result) {
    if (Array.isArray(result)) {
        result = result[0]
    }

    const data = {
        idTaxon: undefined,
        scientificName: "",
        nameSuffix: "",
        mainCommonName: "",
        category: "",
        redList: false,
        url: "",
    }

    // /taxa/sis/{id} has sis_id at the top level, /taxa/scientific_name has it
    // only inside taxon
    const sisId = result && (result.sis_id || (result.taxon && result.taxon.sis_id))
    if (!sisId) {
        return data
    }
    data.idTaxon = `${sisId}`

    if (!result.taxon) {
        return data
    }
    data.scientificName = result.taxon.scientific_name || ""

    const latest = getLatestAssessment(result)
    if (latest && latest.red_list_category_code) {
        data.category = latest.red_list_category_code
        data.redList = RED_LIST_CATEGORIES.includes(data.category)
    }
    if (latest && latest.url) {
        data.url = latest.url
    }

    if (Array.isArray(result.taxon.common_names)) {
        for (const name of result.taxon.common_names) {
            if (name.main && name.name) {
                data.mainCommonName = name.name
                break
            }
        }
    }

    return data
}

// The display name is the scientific name from the IUCN API with any user
// entered suffix appended, e.g. a subspecies epithet.
function displayName(data) {
    if (data.nameSuffix) {
        return `${data.scientificName} ${data.nameSuffix}`
    }
    return data.scientificName
}

// Builds the data that is saved back to fylr.
function toSaveData(data) {
    const name = displayName(data)
    return {
        idTaxon: data.idTaxon,
        scientificName: data.scientificName,
        nameSuffix: data.nameSuffix || "",
        mainCommonName: data.mainCommonName,
        category: data.category,
        redList: data.redList,
        url: data.url || "",
        _fulltext: {
            text: `${name} ${data.mainCommonName}`,
            string: data.idTaxon ? `${data.idTaxon}` : "",
        },
        _standard: {
            text: name,
        },
    }
}

// ------------------------------------------------------------------ fylr API

class FylrApi {
    constructor(info) {
        if (!info.api_url) {
            throw new Error("api_url is missing in info.json")
        }
        if (!info.plugin_user_access_token) {
            throw new Error("plugin_user_access_token is missing in info.json, the plugin user is not available")
        }
        this.url = info.api_url.replace(/\/+$/, "")
        this.token = info.plugin_user_access_token
    }

    request(method, path, body) {
        return request({
            method: method,
            url: this.url + path,
            body: body,
            headers: {
                Authorization: "Bearer " + this.token,
            },
        })
    }

    // Searches records that have one of the values in one of the fields.
    search(objecttypes, fields, values, offset) {
        return this.request("POST", "/api/v1/search", {
            offset: offset,
            limit: SEARCH_LIMIT,
            format: "short",
            objecttypes: objecttypes,
            search: [
                {
                    type: "in",
                    fields: fields,
                    in: values,
                    bool: "must",
                },
            ],
        })
    }

    // A group edit through the _all_fields mask: the plugin user is root, so
    // the mask is always available. base_fields_only is not used, fylr 6.35
    // rejects it together with a mask and 6.34 needs the mask.
    updateTags(objecttype, ids, tagBodies) {
        const body = tagBodies.map((tagBody) => {
            const update = Object.assign({}, tagBody)
            update._objecttype = objecttype
            update[objecttype] = { _id: ids }
            return update
        })
        return this.request("POST", `/api/v1/db/${objecttype}?format=short`, body)
    }
}

// ------------------------------------------------------------------ updating

// Looks up the current IUCN data of one entry. Returns null when the entry is
// not found in the IUCN API.
async function lookupEntry(iucn, data) {
    let result = null
    if (data.idTaxon) {
        result = await iucn.searchBySisTaxonId(data.idTaxon)
    } else if (data.scientificName) {
        // The endpoint needs genus and species, so the scientific name is
        // treated as a latin binomial. It is split at whitespace, the first
        // part is the genus and the second one is the species.
        const parts = data.scientificName.split(/\s+/).filter((part) => part.trim() !== "")
        result = await iucn.searchByTaxonname(parts[0] || "", parts[1] || "")
    } else {
        return null
    }

    if (!getLatestAssessment(result)) {
        return null
    }

    return toObjectData(result)
}

// Splits the configured IUCN fields into direct fields and fields that are
// reached through a linked object.
function parseIucnFields(iucnFields) {
    const fields = []
    const linkedFields = []

    for (const field of iucnFields) {
        const name = field.iucn_field_name
        if (!name) {
            continue
        }
        const index = name.indexOf(LINK_FIELD_SEPARATOR)
        if (index === -1) {
            fields.push(name + ".idTaxon")
            continue
        }
        linkedFields.push({
            linked_field: name.substring(0, index),
            field: name.substring(index + LINK_FIELD_SEPARATOR.length) + ".idTaxon",
        })
    }

    return { fields, linkedFields }
}

function objecttypesOf(fields) {
    return [...new Set(fields.map((field) => field.split(".")[0]))]
}

// Adds or removes the red list tag on the given records.
async function tagObjects(fylr, objects, tagBodies) {
    const idsByObjecttype = {}
    for (const object of objects) {
        const objecttype = object._objecttype
        if (!idsByObjecttype[objecttype]) {
            idsByObjecttype[objecttype] = []
        }
        idsByObjecttype[objecttype].push(object[objecttype]._id)
    }

    for (const [objecttype, ids] of Object.entries(idsByObjecttype)) {
        await fylr.updateTags(objecttype, ids, tagBodies)
    }
}

// Runs a search over all pages and calls handle with the found records.
async function searchAll(fylr, objecttypes, fields, values, handle) {
    if (fields.length === 0 || values.length === 0) {
        return
    }
    let offset = 0
    while (true) {
        const response = await fylr.search(objecttypes, fields, values, offset)
        if (!response.objects || response.objects.length === 0) {
            return
        }
        await handle(response.objects)
        offset += SEARCH_LIMIT
        if (response.count <= offset) {
            return
        }
    }
}

// Tags all records that use one of the entries, either directly or through a
// linked object. All entries must have the same red list state.
async function updateTagsOfEntries(fylr, taxonIds, redList, config) {
    if (taxonIds.length === 0) {
        return
    }

    const tagBodies = []
    if (redList) {
        tagBodies.push({
            _mask: "_all_fields",
            _comment: "IUCN UPDATE - ADD TAG",
            _tags: [{ _id: config.idTagRed }],
            "_tags:group_mode": "tag_add",
        })
    } else {
        tagBodies.push({
            _mask: "_all_fields",
            _comment: "IUCN UPDATE - REMOVE TAG",
            _tags: [{ _id: config.idTagRed }],
            "_tags:group_mode": "tag_remove",
        })
    }

    // records that hold the entry in a field of their own
    await searchAll(fylr, objecttypesOf(config.fields), config.fields, taxonIds, (objects) =>
        tagObjects(fylr, objects, tagBodies)
    )

    // records that hold the entry in a linked object
    const linkFields = config.linkedFields.map((field) => field.field)
    const linkedFields = config.linkedFields.map((field) => field.linked_field + "._global_object_id")
    await searchAll(fylr, objecttypesOf(linkFields), linkFields, taxonIds, async (objects) => {
        const globalObjectIds = objects.map((object) => object._global_object_id)
        await searchAll(fylr, objecttypesOf(linkedFields), linkedFields, globalObjectIds, (linkedObjects) =>
            tagObjects(fylr, linkedObjects, tagBodies)
        )
    })
}

// Reads the tag configuration. Tagging is optional, so it returns null when
// no tag or no field is configured.
function getTagConfig(settings) {
    if (!settings || !settings.tag_red || !Array.isArray(settings.iucn_fields)) {
        return null
    }
    const { fields, linkedFields } = parseIucnFields(settings.iucn_fields)
    if (fields.length === 0 && linkedFields.length === 0) {
        return null
    }
    return { idTagRed: settings.tag_red, fields, linkedFields }
}

// Returns the configured number of days between the updates of an entry.
function getUpdateIntervalDays(config) {
    const interval = config.update_interval_iucn
    const days = interval && interval.days
    if (typeof days === "number" && days > 0) {
        return days
    }
    return DEFAULT_UPDATE_INTERVAL_DAYS
}

// Returns the date when an entry is checked again, spread over a few days so
// that the entries do not all expire at once.
function expiresAt(days) {
    const date = new Date()
    date.setDate(date.getDate() + days + Math.floor(Math.random() * EXPIRY_JITTER_DAYS))
    return date.toISOString()
}

async function update(payload, info, log) {
    const config = pluginConfig(info)
    const iucn = new IUCNApi(config.iucn_api_settings)
    const fylr = new FylrApi(info)
    const tagConfig = getTagConfig(config.iucn_settings)
    const intervalDays = getUpdateIntervalDays(config)

    const updated = []

    for (const object of payload.objects) {
        const startTime = Date.now()

        const data = await lookupEntry(iucn, object.data)
        if (data === null) {
            // The entry is gone from the IUCN API, so the species is no longer
            // on the red list.
            log.push(`entry ${object.identifier} was not found in the IUCN API`)
            object.data = toSaveData(Object.assign({}, object.data, { redList: false }))
        } else {
            // the suffix is entered by the editor and is not part of the IUCN
            // response, so it has to be carried over
            data.nameSuffix = object.data.nameSuffix || ""
            object.data = toSaveData(data)
        }
        object.data._expires_at = expiresAt(intervalDays)
        updated.push(object)

        const elapsed = Date.now() - startTime
        if (elapsed < MIN_ENTRY_DURATION_MS) {
            await wait(MIN_ENTRY_DURATION_MS - elapsed)
        }
    }

    if (tagConfig) {
        // One search and one tag update per group, instead of one per entry.
        const redListIds = []
        const notRedListIds = []
        for (const object of updated) {
            if (!object.data.idTaxon) {
                continue
            }
            if (object.data.redList) {
                redListIds.push(object.data.idTaxon)
            } else {
                notRedListIds.push(object.data.idTaxon)
            }
        }
        await updateTagsOfEntries(fylr, redListIds, true, tagConfig)
        await updateTagsOfEntries(fylr, notRedListIds, false, tagConfig)
    }
    
    log.push(`${updated.length} entries updated`)
    return { payload: updated }
}

// --------------------------------------------------------------------- entry

function pluginConfig(info) {
    const config = info.config && info.config.plugin && info.config.plugin[PLUGIN]
    if (!config || !config.config) {
        throw new Error(`the config of the plugin ${PLUGIN} is missing in info.json`)
    }
    return config.config
}

function respond(body) {
    process.stdout.write(JSON.stringify({ status_code: 200, body: body }))
}

function respondError(error) {
    process.stdout.write(
        JSON.stringify({
            status_code: 400,
            body: { error: error.toString() },
        })
    )
}

async function main(payload, info) {
    const log = []

    switch (payload.action) {
        case "start_update":
            // The updater reads its config from info.json on every call, so
            // there is nothing to keep in the state.
            respond({ state: {}, log: [`${PLUGIN} update started`] })
            return
        case "update":
            if (!Array.isArray(payload.objects)) {
                throw new Error("objects are missing in the payload")
            }
            respond(Object.assign(await update(payload, info, log), { state: payload.state || {}, log: log }))
            return
        case "end_update":
            respond({ state: {}, log: [`${PLUGIN} update done`] })
            return
        default:
            throw new Error(`unsupported action ${payload.action}`)
    }
}

;(() => {
    // info contains api_url, config, plugin_user, plugin_user_access_token
    let info = {}
    try {
        info = JSON.parse(process.argv[2])
    } catch (e) {
        respondError(new Error(`could not parse info.json: ${e}`))
        return
    }

    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", async () => {
        try {
            await main(JSON.parse(data), info)
        } catch (e) {
            console.error(e)
            respondError(e)
        }
    })
})()
