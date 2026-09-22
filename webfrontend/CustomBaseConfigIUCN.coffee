_collectionOptions = null

# Loads the collection list and caches it. Returns the cached options once they
# are there, and a promise while the request is running. CUI.Select accepts both
# and shows a spinner while the promise is pending.
loadCollectionOptions = ->
	return _collectionOptions if _collectionOptions

	placeholder = ->
		return [
			text: $$("server.config.parameter.system.iucn_settings.collection.placeholder")
			value: null
		]

	deferred = new CUI.Deferred()

	xhr = new CUI.XHR
		method: "GET"
		url: "/api/v1/collection/list"
		headers:
			"authorization": "Bearer " + ez5.session.token
			"x-easydb-token": ez5.session.token

	xhr.start().done((data) ->
		options = placeholder()
		flattenCollections(data.collections or data or [], options)
		_collectionOptions = options
		deferred.resolve(options)
	).fail((e) ->
		console.error("could not load the collection list:", e)
		# resolve with the placeholder, a rejected promise would leave the select empty
		deferred.resolve(placeholder())
	)

	return deferred.promise()

# The collection list is a tree. It is flattened into a single list of options,
# the depth is shown as indentation.
flattenCollections = (collections, options, depth = 0) ->
	return unless CUI.util.isArray(collections)
	for coll in collections
		c = coll.collection
		continue unless c
		dn = c.displayname or {}
		# skip the personal top level folder that exists once per user
		continue if Object.values(dn).some((v) -> v is "User Top Level")
		name = dn["de-DE"] or dn["en-US"] or dn["mul-MUL"] or ("Collection " + c._id)
		indent = "  ".repeat(depth)
		options.push(text: indent + name, value: c._id)
		flattenCollections(coll.children or [], options, depth + 1)
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
				field =
					type: CUI.Select
					name: fieldName
					options: -> loadCollectionOptions()
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