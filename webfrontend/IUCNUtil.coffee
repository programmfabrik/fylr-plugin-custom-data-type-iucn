class ez5.IUCNUtil

	@LINK_FIELD_SEPARATOR = ":__link:" # The link separator is used to separate iucn fields from their linked fields.

	@getFieldType: ->
		return "custom:base.custom-data-type-iucn.iucn"

	@getAssessmentData: (assessment_id) ->
		return ez5.IUCNUtil.getFromPlugin("/assessment/" + assessment_id)

	@searchByTaxonname: (genus, species) ->
		return ez5.IUCNUtil.getFromPlugin("/taxa/scientific_name?genus_name=" + encodeURIComponent(genus) + "&species_name=" + encodeURIComponent(species))

	@searchBySisTaxonId: (sis_taxon_id) ->
		return ez5.IUCNUtil.getFromPlugin("/taxa/sis/" + sis_taxon_id)

	@getFromPlugin: (iucn_query) ->
		url_data= {
			"iucn_query": iucn_query
		}
		xhr = new CUI.XHR
			method: "GET"
			url: CUI.appendToUrl(ez5.IUCNUtil.getPluginEndpoint(), url_data)
			headers:
				"authorization": 'Bearer ' + ez5.session.token

		return xhr.start()

	@setObjectData: (object, data) ->
		# When data is empty, clean the object
		if CUI.util.isEmpty(data)
			delete object.idTaxon
			delete object.scientificName
			delete object.nameSuffix
			delete object.mainCommonName
			delete object.category
			delete object.redList
			delete object.url
			return

		if CUI.util.isArray(data)
			data = data[0]

		# nameSuffix holds any user entered tokens beyond the genus and species that
		# were used for the lookup, e.g. a subspecies epithet. It is reset on every
		# lookup, the caller re-applies it after a match.
		object.nameSuffix = ""
		object.redList = false
		object.category = ""
		object.mainCommonName = ""
		object.url = data.url or ""
		object.scientificName = data.scientific_name

		if not data.sis_taxon_id # taxon id not found
			return object

		object.idTaxon = "#{data.sis_taxon_id}"

		if not data.taxon # taxon data not found
			return object

		object.scientificName = data.taxon.scientific_name or ""

		if data.red_list_category.code
			object.category = data.red_list_category.code
			object.redList  = data.red_list_category.code in ["EX", "EW", "CR", "EN", "VU"]

		if not data.taxon.common_names
			return object
		if not CUI.util.isArray(data.taxon.common_names)
			return object
		for n in data.taxon.common_names
			if not n.main
				continue
			if not n.name
				continue
			object.mainCommonName = n.name
			break

		return object

	@isEqual: (objectOne, objectTwo) ->
		for key in ["idTaxon", "scientificName", "nameSuffix", "mainCommonName", "category", "redList"]
			if not CUI.util.isEqual(objectOne[key], objectTwo[key])
				return false
		return true

	# The display name is the scientific name from the IUCN API with any user
	# entered suffix appended, e.g. a subspecies epithet. It is used for the
	# object title and the search text.
	@getDisplayName: (data) ->
		if not CUI.util.isEmpty(data.nameSuffix)
			return "#{data.scientificName} #{data.nameSuffix}"
		return data.scientificName

	@getSaveData: (data) ->
		displayName = ez5.IUCNUtil.getDisplayName(data)
		saveData =
			idTaxon: data.idTaxon
			scientificName: data.scientificName
			nameSuffix: data.nameSuffix or ""
			mainCommonName: data.mainCommonName
			category: data.category
			redList: data.redList
			url: data.url or ""
			_fulltext:
				text: "#{displayName} #{data.mainCommonName}"
				string: if data.idTaxon? then "#{data.idTaxon}" else ""
			_standard:
				text: displayName
		return saveData

	@getSettings: ->
		return ez5.session.getBaseConfig("plugin", "custom-data-type-iucn").iucn_settings

	@getPluginEndpoint: ->
		# return the url + endpoint to call the internal proxy that performs requests against the iucn api
		return ez5.pluginManager.getPlugin('custom-data-type-iucn')?.__plugin_url + "/proxy_api_v4"

	@getLatestAssessmentIdFromSearchResult: (data) ->
		if not data
			return 0

		# parse result, find id of latest assessment
		if not CUI.util.isArray(data.assessments)
			return 0

		for a in data.assessments
			if not a.latest
				continue
			if not a.assessment_id
				continue
			return a.assessment_id

		return 0