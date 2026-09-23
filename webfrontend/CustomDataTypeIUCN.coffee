class CustomDataTypeIUCN extends CustomDataType

	getCustomDataTypeName: ->
		return ez5.IUCNUtil.getFieldType()

	getCustomDataTypeNameLocalized: ->
		return	$$("custom.data.type.iucn.name")

	getCustomDataOptionsInDatamodelInfo: ->
		return []

	renderSearchInput: (data, opts={}) ->
		return new SearchToken(
			column: @
			data: data
			fields: opts.fields
		).getInput().DOM

	getFieldNamesForSearch: ->
		@__getFieldNames()

	getFieldNamesForSuggest: ->
		@__getFieldNames()

	getSearchFilter: (data, key=@name()) ->
		if data[key+":unset"]
			filter =
				type: "in"
				fields: [ @fullName()+".scientificName" ]
				in: [ null ]
			filter._unnest = true
			filter._unset_filter = true
			return filter

		filter = super(data, key)
		if filter
			return filter

		if CUI.util.isEmpty(data[key])
			return

		val = data[key]
		[str, phrase] = Search.getPhrase(val)

		switch data[key+":type"]
			when "token", "fulltext", undefined
				filter =
					type: "match"
					mode: data[key+":mode"]
					fields: @getFieldNamesForSearch()
					string: str
					phrase: phrase
			when "field"
				filter =
					type: "in"
					fields: @getFieldNamesForSearch()
					in: [ str ]
		filter

	__getFieldNames: ->
		fieldNames = [
			@fullName()+".idTaxon"
			@fullName()+".scientificName"
			@fullName()+".mainCommonName"
		]
		return fieldNames

	getQueryFieldBadge: (data) =>
		if data["#{@name()}:unset"]
			value = $$("text.column.badge.without")
		else
			value = data[@name()]
		name: @nameLocalized()
		value: value

	renderEditorInput: (data) ->
		data = @__initData(data)
		div = CUI.dom.div()

		toggleOutput = =>
			CUI.Events.trigger
				node: div
				type: "editor-changed"

			if data.idTaxon or data.scientificName
				output = @__getOutput(data, true, =>
					ez5.IUCNUtil.setObjectData(data) # Empty data.
					toggleOutput()
				)
				CUI.dom.replace(div, output)
			else
				CUI.dom.replace(div, searchField)

		searchField = @__getSearchField(data, toggleOutput)
		toggleOutput()

		return div

	__getSearchField: (data, onSearch) ->
		doSearch = =>
			searchButton.startSpinner()

			if isNaN(data.searchName)
				# if the search input is not numerical, use it as a scientific name
				# endpoint needs genus and species so treat the input as a latin binomial
				# split at whitespace, use first part as genus and second (if any) as species name
				parts = data.searchName.split(/\s+/).filter (part) -> part.trim() != ""
				genus = ""
				species = ""
				if parts.length > 0
					genus = parts[0]
				if parts.length > 1
					species = parts[1]
				# tokens beyond genus and species, e.g. a subspecies epithet, are not
				# used for the lookup but are kept as the name suffix so that they
				# still appear in the object title after a match
				nameSuffix = if parts.length > 2 then parts.slice(2).join(" ") else ""

				ez5.IUCNUtil.searchByTaxonname(genus, species).done((response) ->
					if not response
						CUI.alert(text: $$("custom.data.type.iucn.editor.search.token-invalid"), markdown: true)
						return

					_assessment_id = ez5.IUCNUtil.getLatestAssessmentIdFromSearchResult(response)
					if _assessment_id == 0 or CUI.util.isEmpty(response)
						ez5.IUCNUtil.setObjectData(data, scientific_name: data.searchName)
						onSearch()
					else
						ez5.IUCNUtil.getAssessmentData(_assessment_id).done((response) ->
							if not response
								CUI.alert(text: $$("custom.data.type.iucn.editor.search.token-invalid"), markdown: true)
								return

							ez5.IUCNUtil.setObjectData(data, response)
							data.nameSuffix = nameSuffix
							onSearch()
						).fail((e) ->
							ez5.IUCNUtil.setObjectData(data, scientific_name: data.searchName)
							return
						)
				).always(-> searchButton.stopSpinner())

			else
				# if there are only numbers in the search input, it could be a taxon id
				ez5.IUCNUtil.searchBySisTaxonId(data.searchName).done((response) ->
					if not response
						CUI.alert(text: $$("custom.data.type.iucn.editor.search.token-invalid"), markdown: true)
						return

					_assessment_id = ez5.IUCNUtil.getLatestAssessmentIdFromSearchResult(response)
					if _assessment_id == 0 or CUI.util.isEmpty(response)
						ez5.IUCNUtil.setObjectData(data, scientific_name: data.searchName)
						onSearch()
					else
						ez5.IUCNUtil.getAssessmentData(_assessment_id).done((response) ->
							if not response
								CUI.alert(text: $$("custom.data.type.iucn.editor.search.token-invalid"), markdown: true)
								return

							ez5.IUCNUtil.setObjectData(data, response)
							onSearch()
						).fail((e) ->
							ez5.IUCNUtil.setObjectData(data, scientific_name: data.searchName)
							return
						)
				).always(-> searchButton.stopSpinner())

		searchButton = new CUI.Button
			icon: "search"
			class: "ez5-custom-data-type-iucn-search-button"
			tooltip:
				text: $$("custom.data.type.iucn.editor.search-button.tooltip")
			onClick: doSearch

		toggleButton = ->
			if CUI.util.isEmpty(data.searchName)
				searchButton.disable()
			else
				searchButton.enable()
			return

		searchInput = new CUI.Input
			data: data
			class: "ez5-custom-data-type-iucn-search-input"
			name: "searchName"
			placeholder: $$("custom.data.type.iucn.editor.search-input.placeholder")
			onDataInit: toggleButton
			onDataChanged: toggleButton
		searchInput.start()

		CUI.Events.listen
			node: searchInput
			type: "keyup"
			call: (ev) =>
				if ev.keyCode() != 13
					return
				doSearch()
				return

		layout = new CUI.HorizontalLayout
			center:
				content: searchInput
			right:
				content: searchButton
		return layout

	__getOutput: (data, isEditor = false, onDelete) ->
		if data.redList
			statusText = $$("custom.data.type.iucn.output.status.red-list.text")
		else
			statusText = $$("custom.data.type.iucn.output.status.not-on-red-list.text")

		if isEditor
			menuButton = new LocaButton
				loca_key: "custom.data.type.iucn.editor.menu.button"
				icon: "ellipsis_v"
				icon_right: false
				appearance: "flat"
				menu:
					items: [
						new LocaButton
							loca_key: "custom.data.type.iucn.editor.menu.delete-button"
							onClick: =>
								onDelete?()
					]

		rightContent = new CUI.HorizontalLayout(right: content: "")
		if data.redList
			idRedListTag = ez5.IUCNUtil.getSettings()?.tag_red
			tag = ez5.tagForm.findTagByAnyId(idRedListTag)
			if tag
				rightContent.append(tag.getLabel(), "center")

		if isEditor
			rightContent.append(menuButton, "right")

		if data.idTaxon
			# use the Red List url from the assessment, fall back to a plain label
			# for entries that were saved before the url was stored
			if data.url
				nameContent = new CUI.ButtonHref
					text: data.mainCommonName
					class: "pluginResultButton"
					appearance: "link"
					href: data.url
					target: "_blank"
			else
				nameContent = new CUI.Label(text: data.mainCommonName)
			content = new CUI.VerticalList(content: [
				nameContent
				new CUI.Label(text: "#{data.idTaxon} - #{ez5.IUCNUtil.getDisplayName(data)}", appearance: "secondary")
				new CUI.Label(text: statusText, appearance: "secondary")
			])
		else
			content = new CUI.Label(text: ez5.IUCNUtil.getDisplayName(data))

		layout = new CUI.HorizontalLayout(
			class: "ez5-field-object ez5-custom-data-type-iucn-card"
			left:
				content: @__getLogoImage()
			center:
				content: content
			right:
				content: rightContent
		)
		return layout

	renderDetailOutput: (data, _, opts) ->
		data = @__initData(data)
		return @__getOutput(data)

	getSaveData: (data, save_data) ->
		data = data[@name()]
		if CUI.util.isEmpty(data)
			return save_data[@name()] = null

		return save_data[@name()] = ez5.IUCNUtil.getSaveData(data)

	isEmpty: (data, _, opts = {}) ->
		data = data[@name()]

		if opts.mode == "expert"
			return CUI.util.isEmpty(data?.trim())

		return CUI.util.isEmpty(data?.idTaxon) and CUI.util.isEmpty(data?.scientificName)

	__initData: (data) ->
		if not data[@name()]
			initData = {}
			data[@name()] = initData
		else
			initData = data[@name()]
		initData

	__getLogoImage: ->
		if @__previewImage
			return @__previewImage
		plugin = ez5.pluginManager.getPlugin("custom-data-type-iucn")
		@__previewImage = new Image()
		@__previewImage.src = plugin.getBaseURL() + plugin.getWebfrontend().logo
		return @__previewImage

	renderFieldAsGroup: ->
		return false

	supportsStandard: ->
		return true

CustomDataType.register(CustomDataTypeIUCN)