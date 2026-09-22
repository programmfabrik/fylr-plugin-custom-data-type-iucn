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

// The IUCN API allows 120 requests per minute. The updater needs two requests
// per entry, so it waits until an entry took at least this long.
const MIN_ENTRY_DURATION_MS = 1000

// page size of the searches for records to tag
const SEARCH_LIMIT = 1000

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

    getAssessment(assessmentId) {
        return this.get("/assessment/" + encodeURIComponent(assessmentId))
    }
}

// Returns the id of the latest assessment of a search result, 0 if there is
// none.
function getLatestAssessmentId(data) {
    if (!data || !Array.isArray(data.assessments)) {
        return 0
    }
    for (const assessment of data.assessments) {
        if (assessment.latest && assessment.assessment_id) {
            return assessment.assessment_id
        }
    }
    return 0
}

// Builds the custom data of an entry from an assessment.
function toObjectData(assessment) {
    if (Array.isArray(assessment)) {
        assessment = assessment[0]
    }

    const data = {
        idTaxon: undefined,
        scientificName: assessment.scientific_name || "",
        mainCommonName: "",
        category: "",
        redList: false,
    }

    if (!assessment.sis_taxon_id) {
        return data
    }
    data.idTaxon = `${assessment.sis_taxon_id}`

    if (!assessment.taxon) {
        return data
    }
    data.scientificName = assessment.taxon.scientific_name || ""

    if (assessment.red_list_category && assessment.red_list_category.code) {
        data.category = assessment.red_list_category.code
        data.redList = RED_LIST_CATEGORIES.includes(data.category)
    }

    if (Array.isArray(assessment.taxon.common_names)) {
        for (const name of assessment.taxon.common_names) {
            if (name.main && name.name) {
                data.mainCommonName = name.name
                break
            }
        }
    }

    return data
}

// Builds the data that is saved back to fylr.
function toSaveData(data) {
    return {
        idTaxon: data.idTaxon,
        scientificName: data.scientificName,
        mainCommonName: data.mainCommonName,
        category: data.category,
        redList: data.redList,
        _fulltext: {
            text: `${data.scientificName} ${data.mainCommonName}`,
            string: data.idTaxon ? `${data.idTaxon}` : "",
        },
        _standard: {
            text: data.scientificName,
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

    updateTags(objecttype, ids, tagBodies) {
        const body = tagBodies.map((tagBody) => {
            const update = Object.assign({}, tagBody)
            update._objecttype = objecttype
            update[objecttype] = { _id: ids }
            return update
        })
        return this.request("POST", `/api/v1/db/${objecttype}?base_fields_only=1&format=short`, body)
    }

    pushToCollection(collectionId, objects) {
        return this.request("POST", `/api/v1/collection/push/${collectionId}`, { objects: objects })
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

    const assessmentId = getLatestAssessmentId(result)
    if (!assessmentId) {
        return null
    }

    const assessment = await iucn.getAssessment(assessmentId)
    if (!assessment || Object.keys(assessment).length === 0) {
        return null
    }

    return toObjectData(assessment)
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

// Returns the records whose red list tag actually changes. Records that already
// carry the right tag are left out, so that only real changes are collected.
function changedRecords(objects, redList, idTagRed) {
    return objects.filter((object) => {
        const hasTag = (object._tags || []).some((tag) => tag._id === idTagRed)
        return redList ? !hasTag : hasTag
    })
}

// Tags all records that use the entry, either directly or through a linked
// object. The records whose tag changed are pushed into the configured
// collection, when there is one.
async function updateTagsOfEntry(fylr, data, config, log) {
    const tagBodies = []
    if (data.redList) {
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

    const changed = []
    const handleObjects = async (objects) => {
        await tagObjects(fylr, objects, tagBodies)
        if (!config.collectionId) {
            return
        }
        for (const object of changedRecords(objects, data.redList, config.idTagRed)) {
            changed.push({ _global_object_id: object._global_object_id })
        }
    }

    // records that hold the entry in a field of their own
    await searchAll(fylr, objecttypesOf(config.fields), config.fields, [data.idTaxon], handleObjects)

    // records that hold the entry in a linked object
    const linkFields = config.linkedFields.map((field) => field.field)
    const linkedFields = config.linkedFields.map((field) => field.linked_field + "._global_object_id")
    await searchAll(fylr, objecttypesOf(linkFields), linkFields, [data.idTaxon], async (objects) => {
        const globalObjectIds = objects.map((object) => object._global_object_id)
        await searchAll(fylr, objecttypesOf(linkedFields), linkedFields, globalObjectIds, handleObjects)
    })

    if (config.collectionId && changed.length > 0) {
        try {
            await fylr.pushToCollection(config.collectionId, changed)
            log.push(`pushed ${changed.length} records into collection ${config.collectionId}`)
        } catch (e) {
            // a collection that cannot be written must not fail the whole batch
            log.push(`could not push into collection ${config.collectionId}: ${e}`)
        }
    }
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
    return {
        idTagRed: settings.tag_red,
        fields,
        linkedFields,
        collectionId: settings.collection_id || null,
    }
}

async function update(payload, info, log) {
    const config = pluginConfig(info)
    const iucn = new IUCNApi(config.iucn_api_settings)
    const fylr = new FylrApi(info)
    const tagConfig = getTagConfig(config.iucn_settings)

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
            object.data = toSaveData(data)
        }
        updated.push(object)

        if (tagConfig && object.data.idTaxon) {
            await updateTagsOfEntry(fylr, object.data, tagConfig, log)
        }

        const elapsed = Date.now() - startTime
        if (elapsed < MIN_ENTRY_DURATION_MS) {
            await wait(MIN_ENTRY_DURATION_MS - elapsed)
        }
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
