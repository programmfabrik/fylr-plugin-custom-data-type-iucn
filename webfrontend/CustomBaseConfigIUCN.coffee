_collectionOptions = null

PLACEHOLDER = "server.config.parameter.system.iucn_settings.collection.placeholder"

# The system collections have a displayname keyed "und" that holds a reference
# like "collection.name.system:root". They are not worth showing in a label.
isSystemCollectionName = (displayname) ->
	und = (displayname or {}).und
	return CUI.util.isString(und) and und.indexOf("collection.name.system:") == 0

# _path holds the collection and its ancestors. The label is the chain of names
# without the system collections on top of it, like the field selector shows it.
collectionLabel = (row) ->
	names = []
	for entry in (row._path or [])
		collection = entry.collection
		continue unless collection
		continue if isSystemCollectionName(collection.displayname)
		name = ez5.loca.getBestFrontendValue(collection.displayname)
		names.push(if CUI.util.isEmpty(name) then "#{collection._id}" else name)
	if names.length == 0
		return "#{row.collection._id}"
	return names.join(" / ")

# The list endpoint answers at most PAGE_SIZE rows and the system collections,
# one per user, take up most of them, so it has to be read page by page.
COLLECTION_PAGE_SIZE = 1000
MAX_COLLECTION_PAGES = 50

_loadingCollections = false

# Loads the collection list and keeps it. The list is flat, the tree is in _path.
loadCollectionOptions = ->
	return if _loadingCollections
	_loadingCollections = true

	options = [
		text: $$(PLACEHOLDER)
		value: null
	]

	loadPage = (page) ->
		ez5.api.collection(
			api: "/list"
			data:
				limit: COLLECTION_PAGE_SIZE
				offset: page * COLLECTION_PAGE_SIZE
		).done((data) ->
			rows = data.collections or data.objects or data or []
			for row in rows
				collection = row?.collection
				continue unless collection
				continue if collection.is_system_collection
				options.push(text: collectionLabel(row), value: collection._id)

			if rows.length == COLLECTION_PAGE_SIZE and page + 1 < MAX_COLLECTION_PAGES
				loadPage(page + 1)
				return

			# only keep a list that was read to the end
			_collectionOptions = options
			_loadingCollections = false
		).fail((e) ->
			console.error("could not load the collection list:", e)
			_loadingCollections = false
		)
		return

	loadPage(0)
	return


class ez5.CustomBaseConfigIUCN extends BaseConfigPlugin

	getFieldDefFromParm: (baseConfig, fieldName, def) ->
		switch def.plugin_type
			when 'iucn_tag'
				options = [
					text: $$("server.config.parameter.system.iucn_settings.tag.placeholder.#{fieldName}")
					value: null
				]

				for tagGroup in ez5.tagForm.tagGroups
					options.push(label: tagGroup.getDisplayName())
					for tag in tagGroup.getTags()
						options.push
							text: tag.getDisplayName()
							value: tag.getId()
				field =
					type: CUI.Select
					name: fieldName
					options: options
			when 'iucn_field_name'
				options = @__searchInAllObjecttypes()

				field =
					type: CUI.Select
					name: fieldName
					options: options

			when 'iucn_collection'
				# the options have to be there synchronously, options that arrive
				# later mark the base config as changed
				options = _collectionOptions or [
					text: $$(PLACEHOLDER)
					value: null
				]
				loadCollectionOptions() # refresh for the next time the panel opens
				field =
					type: CUI.Select
					name: fieldName
					options: options
		return field

	# Search in all objecttypes using a 'filter' function.
	# Applies the filter function to each field and adds it to an array of options.
	__searchInAllObjecttypes: ->
		optionsByObjecttype = {}

		addField = (tableName, field, path = "", fieldPath = []) ->
			if field not instanceof CustomDataTypeIUCN
				return

			value = path + field.fullName()
			# Do not add duplicated fields.
			if optionsByObjecttype[tableName].some((option) -> option.value == value)
				return

			fieldPath.push(field)
			label = fieldPath.map((_field) -> _field.fullNameLocalized()).join(" / ")
			optionsByObjecttype[tableName].push
				text: label
				value: value

		# Avoid using recursive 'getFields' to avoid problems.
		getLinkedFields = (linkedField) ->
			idTable = linkedField.linkMask().table.id()
			path = linkedField.fullName() + ez5.IUCNUtil.LINK_FIELD_SEPARATOR

			tableName = path.split(".")[0]
			mask = Mask.getMaskByMaskName("_all_fields", idTable)
			mask.invokeOnFields("all", true, ((field) =>
					addField(tableName, field, path, [linkedField])
			))
			return

		getFields = (idTable) ->
			mask = Mask.getMaskByMaskName("_all_fields", idTable)

			if not mask.hasTags()
				return

			tableName = mask.table.name()

			tableNameLocalized = mask.table.nameLocalized()
			if not optionsByObjecttype[tableName]
				optionsByObjecttype[tableName] = [label: tableNameLocalized]

			mask.invokeOnFields("all", true, ((field) =>
				if field instanceof MaskSplitter
					return

				if field.isTopLevelField() or field.isSystemField() # Skip top level and system fields.
					return

				if field instanceof LinkedObject
					# Skip linked objects to the same object.
					if field.table.id() == field.linkMask().table.id()
						return
					getLinkedFields(field)
					return
				else if field instanceof ReverseLinkedTable
					for _field in field.getFields("all")
						if _field not instanceof LinkedObject
							addField(tableName, _field)
							continue

						# Linked object.
						getLinkedFields(_field)
					return

				addField(tableName, field)
				return
			))

		for _, objecttype of ez5.schema.CURRENT._objecttype_by_name
			if objecttype.name.indexOf('@') > -1 # Skip connector objecttypes.
				continue
			getFields(objecttype.table_id)

		options = [
			text: $$("server.config.parameter.system.iucn_settings.iucn_fields.placeholder")
			value: null
		]
		for _, _options of optionsByObjecttype
			if _options.length == 1
				continue
			options = options.concat(_options)
		return options



ez5.session_ready =>
	BaseConfig.registerPlugin(new ez5.CustomBaseConfigIUCN())
	# only users who can open the base config need the list
	if ez5.session.hasSystemRight("root", "config")
		loadCollectionOptions()
