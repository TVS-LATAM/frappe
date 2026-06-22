import KanbanSettings from "./kanban_settings";
import CardPreviewSettings from "./card_preview_settings";

frappe.provide("frappe.views");

// Name of the Project kanban board that represents the workshop floor. Workshop-only
// UI (queue filter, preview/colour controls, freeze-queue toggle, lane icon) is gated
// on this so it doesn't leak into other Project boards (e.g. "Parts", "Remote Diagnose").
const WORKSHOP_KANBAN_BOARD = "workshop";

// Match the workshop board regardless of casing/whitespace ("Workshop", "WORKSHOP", ...).
frappe.views.is_workshop_kanban = function (board_name) {
	return (board_name || "").trim().toLowerCase() === WORKSHOP_KANBAN_BOARD;
};

frappe.views.KanbanView = class KanbanView extends frappe.views.ListView {
	static no_sidebar = true;

	static load_last_view() {
		const route = frappe.get_route();
		if (route.length === 3) {
			const doctype = route[1];
			// Prefer the last kanban this browser was on so normal back/forward
			// navigation returns the user to where they were, falling back to the
			// server-side last_kanban_board only if nothing is stored locally.
			let last_board = null;
			try {
				const stored = JSON.parse(localStorage.getItem(`last_kanban_route:${doctype}`));
				last_board = stored && stored.board;
			} catch (e) {
				last_board = null;
			}
			if (!last_board) {
				const user_settings = frappe.get_user_settings(doctype)["Kanban"] || {};
				last_board = user_settings.last_kanban_board;
			}
			if (!last_board) {
				return new frappe.views.KanbanView({ doctype: doctype });
			}

			route.push(last_board);
			frappe.set_route(route);
			return true;
		}
		return false;
	}

	get view_name() {
		return "Kanban";
	}

	show() {
		frappe.views.KanbanView.get_kanbans(this.doctype).then((kanbans) => {
			if (!kanbans.length) {
				return frappe.views.KanbanView.show_kanban_dialog(this.doctype);
			} else if (kanbans.length && frappe.get_route().length !== 4) {
				return frappe.views.KanbanView.show_kanban_dialog(this.doctype);
			} else {
				this.kanbans = kanbans;

				return frappe.run_serially([
					() => this.show_skeleton(),
					() => this.fetch_meta(),
					() => this.hide_skeleton(),
					() => this.check_permissions(),
					() => this.init(),
					() => this.before_refresh(),
					() => this.refresh(),
				]);
			}
		});
	}

	init() {
		return super.init().then(() => {
			let menu_length = this.page.menu.find(".dropdown-item").length;
			if (menu_length === 1) {
				// Only 'Refresh' (hidden) is present (always), dropdown is visibly empty
				this.page.hide_menu();
			}
		});
	}

	setup_defaults() {
		return super.setup_defaults().then(() => {
			let get_board_name = () => {
				return this.kanbans.length && this.kanbans[0].name;
			};

			this.board_name = frappe.get_route()[3] || get_board_name() || null;
			this.page_title = __(this.board_name);
			this.card_meta = this.get_card_meta();
			this.page_length = 0;

			return frappe.run_serially([
				() => this.set_board_perms_and_push_menu_items(),
				() => this.get_board(),

			]);
		});
	}

	set_board_perms_and_push_menu_items() {
		// needs server-side call as client-side document instance is absent before kanban render
		return frappe.call({
			method: "frappe.client.get_doc_permissions",
			args: {
				doctype: "Kanban Board",
				docname: this.board_name,
			},
			callback: (result) => {
				this.board_perms = result.message.permissions || {};
				this.push_menu_items();
			},
		});
	}

	async push_menu_items() {
		if (this.board_perms.write) {
			this.menu_items.push({
				label: __("Save filters"),
				action: () => {
					this.save_kanban_board_filters();
				},
			});

			// Add Card Preview Settings menu item
			this.menu_items.push({
				label: __("Card Preview Settings"),
				action: () => {
					console.log("action card preview")
					this.show_card_preview_settings();
				},
			});
		}

		if (this.board_perms.delete) {
			this.menu_items.push({
				label: __("Delete Kanban Board"),
				action: () => {
					frappe.confirm(__("Are you sure you want to proceed?"), () => {
						frappe.db.delete_doc("Kanban Board", this.board_name).then(() => {
							frappe.show_alert(`Kanban Board ${this.board_name} deleted.`);
							frappe.set_route("List", this.doctype, "List");
						});
					});
				},
			});
		}
	}

	setup_paging_area() {
		// pass
	}

	toggle_result_area() {
		this.$result.toggle(this.data.length > 0);
	}

	get_board() {
		return frappe.db.get_doc("Kanban Board", this.board_name).then((board) => {
			this.board = board;
			this.board.filters_array = JSON.parse(this.board.filters || "[]");
			this.board.fields = JSON.parse(this.board.fields || "[]");
			this.board.card_fields = JSON.parse(this.board.card_fields || "[]");
			this.filters = this.board.filters_array;
		});
	}

	setup_page() {
		this.hide_sidebar = true;
		this.hide_page_form = false;
		this.hide_card_layout = true;
		this.hide_sort_selector = true;
		super.setup_page();
	}

	setup_view() {
		if (this.board.columns.filter((col) => col.status !== "Archived").length > 5) {
			this.page.container.addClass("full-width");
		}
		this.setup_realtime_updates();
		this.setup_like();
	}

	setup_realtime_updates() {
		this.pending_document_refreshes = [];
		if (this.list_view_settings?.disable_auto_refresh || this.realtime_events_setup) {
			return;
		}
		frappe.realtime.doctype_subscribe(this.doctype);
		frappe.realtime.off("list_update");

		let _pendingNames = [];
		let _debounceTimer = null;

		const flushPendingUpdates = () => {
			if (!_pendingNames.length) return;
			const names = [..._pendingNames];
			_pendingNames = [];
			frappe.call({
				method: 'frappe.desk.reportview.get',
				args: {
					"doctype": this.doctype,
					"fields": this.fields.map(f => Array.isArray(f) ? f[0] : f),
					"filters": [['name', 'in', names]],
					"start": 0,
					"page_length": names.length,
					"view": "List",
					"with_comment_count": 1
				}
			}).then((res) => {
				const cards = frappe.utils.dict(res.message.keys, res.message.values);
				this.kanban.update_cards(cards);
			});
		};

		frappe.realtime.on("list_update", (data) => {
			if (data?.doctype !== this.doctype) return;
			// if some bulk operation is happening by selecting list items, don't refresh
			if (this.$checks && this.$checks.length) return;
			if (this.avoid_realtime_update()) return;

			_pendingNames.push(data.name);
			clearTimeout(_debounceTimer);
			_debounceTimer = setTimeout(flushPendingUpdates, 400);
		});
		this.realtime_events_setup = true;
	}

	set_fields() {
		super.set_fields();
		this._add_field(this.card_meta.title_field);
	}

	async before_render() {
		frappe.model.user_settings.save(this.doctype, "last_view", this.view_name);
		this.save_view_user_settings({
			last_kanban_board: this.board_name,
		});
		// Persist the kanban the user is currently on, per browser, so that returning
		// from a Job Card / Appointment lands them back here instead of being forced
		// to their default kanban board.
		try {
			localStorage.setItem(
				`last_kanban_route:${this.doctype}`,
				JSON.stringify({ board: this.board_name })
			);
		} catch (e) {
			// localStorage may be unavailable (e.g. private mode); ignore.
		}
		const isWorkshopViewer = await erpnext.utils.isWorkshopViewer(this.frm);
		const isMechanic = await erpnext.utils.isMechanic(this.frm);
		const isJuniorMechanic = await erpnext.utils.isJuniorMechanic(this.frm);
		const isSeniorMechanic = await erpnext.utils.isSeniorMechanic(this.frm);

		if (!isWorkshopViewer && !isMechanic && !isJuniorMechanic && !isSeniorMechanic) {
			insertFreezeQueuePosition(this)
		} else {
			const sidebar = $(".layout-side-section");
			if (sidebar.is(':visible')) {
				sidebar.hide();
			}
		}

	}

	render_list() { }

	on_filter_change() {
		if (!this.board_perms.write) return; // avoid misleading ux

		if (JSON.stringify(this.board.filters_array) !== JSON.stringify(this.filter_area.get())) {
			this.page.set_indicator(__("Not Saved"), "orange");
		} else {
			this.page.clear_indicator();
		}

		let filters = this.get_call_args().args.filters
		const filters_fields = document.querySelectorAll('.input-with-feedback:not([type="checkbox"])');
		const defaultBorder = 'none';
		const highlightBorder = '2px solid red';

		filters_fields.forEach(filter => {
			filter.style.border = defaultBorder;

			if (filters.length) {
				const fieldName = filter.getAttribute('data-fieldname');
				const hasValue = filters.some(([_, name]) => name === fieldName);

				if (hasValue) {
					filter.style.border = highlightBorder;
				}
			}
		})

	}

	save_kanban_board_filters() {
		const filters = this.filter_area.get();

		frappe.db.set_value("Kanban Board", this.board_name, "filters", filters).then((r) => {
			if (r.exc) {
				frappe.show_alert({
					indicator: "red",
					message: __("There was an error saving filters"),
				});
				return;
			}
			frappe.show_alert({
				indicator: "green",
				message: __("Filters saved"),
			});

			this.board.filters_array = filters;
			this.on_filter_change();
		});
	}

	get_fields() {
		this.fields.push([this.board.field_name, this.board.reference_doctype]);
		return super.get_fields();
	}

	render() {
		const board_name = this.board_name;
		if (!this.kanban) {
			this.kanban = new frappe.views.KanbanBoard({
				doctype: this.doctype,
				board: this.board,
				board_name: board_name,
				cards: this.data,
				card_meta: this.card_meta,
				wrapper: this.$result,
				cur_list: this,
				user_settings: this.view_user_settings,
			});
		} else if (board_name === this.kanban.board_name) {
			this.kanban.update(this.data);
		}
	}


	get_card_meta() {
		var meta = frappe.get_meta(this.doctype);
		// preserve route options erased by new doc
		let route_options = { ...frappe.route_options };
		var doc = frappe.model.get_new_doc(this.doctype);
		frappe.route_options = route_options;
		var title_field = null;
		var quick_entry = false;

		if (this.meta.title_field) {
			title_field = frappe.meta.get_field(this.doctype, this.meta.title_field);
		}

		this.meta.fields.forEach((df) => {
			const is_valid_field =
				["Data", "Text", "Small Text", "Text Editor"].includes(df.fieldtype) && !df.hidden;

			if (is_valid_field && !title_field) {
				// can be mapped to textarea
				title_field = df;
			}
		});

		// quick entry
		var mandatory = meta.fields.filter((df) => df.reqd && !doc[df.fieldname]);

		if (
			mandatory.some((df) => frappe.model.table_fields.includes(df.fieldtype)) ||
			mandatory.length > 1
		) {
			quick_entry = true;
		}

		if (!title_field) {
			title_field = frappe.meta.get_field(this.doctype, "name");
		}

		return {
			quick_entry: quick_entry,
			title_field: title_field,
		};
	}

	get_view_settings() {
		return {
			label: __("Kanban Settings", null, "Button in kanban view menu"),
			action: () => this.show_kanban_settings(),
			standard: true,
		};
	}

	show_kanban_settings() {
		frappe.model.with_doctype(this.doctype, () => {
			new KanbanSettings({
				kanbanview: this,
				doctype: this.doctype,
				settings: this.board,
				meta: frappe.get_meta(this.doctype),
			});
		});
	}

	show_card_preview_settings() {
		frappe.model.with_doctype(this.doctype, () => {
			new CardPreviewSettings({
				kanbanview: this,
				doctype: this.doctype,
				settings: this.board,
				meta: frappe.get_meta(this.doctype),
			});
		});
	}

	get required_libs() {
		return "kanban_board.bundle.js";
	}
};

frappe.views.KanbanView.get_kanbans = function (doctype) {
	let kanbans = [];

	return get_kanban_boards().then((kanban_boards) => {
		if (kanban_boards) {
			kanban_boards.forEach((board) => {
				let route = `/app/${frappe.router.slug(board.reference_doctype)}/view/kanban/${board.name
					}`;
				kanbans.push({ name: board.name, route: route });
			});
		}

		return kanbans;
	});

	function get_kanban_boards() {
		return frappe
			.call("frappe.desk.doctype.kanban_board.kanban_board.get_kanban_boards", { doctype })
			.then((r) => r.message);
	}
};

frappe.views.KanbanView.show_kanban_dialog = function (doctype) {
	let dialog = new_kanban_dialog();
	dialog.show();

	function make_kanban_board(board_name, field_name, project) {
		return frappe.call({
			method: "frappe.desk.doctype.kanban_board.kanban_board.quick_kanban_board",
			args: {
				doctype,
				board_name,
				field_name,
				project,
			},
			callback: function (r) {
				var kb = r.message;
				if (kb.filters) {
					frappe.provide("frappe.kanban_filters");
					frappe.kanban_filters[kb.kanban_board_name] = kb.filters;
				}
				frappe.set_route("List", doctype, "Kanban", kb.kanban_board_name);
			},
		});
	}

	function new_kanban_dialog() {
		/* Kanban dialog can show either "Save" or "Customize Form" option depending if any Select fields exist in the DocType for Kanban creation
		 */

		const select_fields = frappe.get_meta(doctype).fields.filter((df) => {
			return df.fieldtype === "Select" && df.fieldname !== "kanban_column";
		});
		const dialog_fields = get_fields_for_dialog(select_fields);
		const to_save = select_fields.length > 0;
		const primary_action_label = to_save ? __("Save") : __("Customize Form");
		const dialog_title = to_save ? __("New Kanban Board") : __("No Select Field Found");

		let primary_action = () => {
			if (to_save) {
				const values = dialog.get_values();
				make_kanban_board(values.board_name, values.field_name, values.project).then(
					() => dialog.hide(),
					(err) => frappe.msgprint(err)
				);
			} else {
				frappe.set_route("Form", "Customize Form", { doc_type: doctype });
			}
		};

		return new frappe.ui.Dialog({
			title: dialog_title,
			fields: dialog_fields,
			primary_action_label,
			primary_action,
		});
	}

	function get_fields_for_dialog(select_fields) {
		if (!select_fields.length) {
			return [
				{
					fieldtype: "HTML",
					options: `
					<div>
						<p class="text-medium">
						${__(
						'No fields found that can be used as a Kanban Column. Use the Customize Form to add a Custom Field of type "Select".'
					)}
						</p>
					</div>
				`,
				},
			];
		}

		let fields = [
			{
				fieldtype: "Data",
				fieldname: "board_name",
				label: __("Kanban Board Name"),
				reqd: 1,
				description: ["Note", "ToDo"].includes(doctype)
					? __("This Kanban Board will be private")
					: "",
			},
			{
				fieldtype: "Select",
				fieldname: "field_name",
				label: __("Columns based on"),
				options: select_fields.map((df) => ({ label: df.label, value: df.fieldname })),
				default: select_fields[0],
				reqd: 1,
			},
		];

		if (doctype === "Task") {
			fields.push({
				fieldtype: "Link",
				fieldname: "project",
				label: __("Project"),
				options: "Project",
			});
		}

		return fields;
	}
};

async function insertFreezeQueuePosition(context) {
	if (context.doctype !== 'Project') return;
	// Scope DOM lookups to the current board's page wrapper. Frappe caches each
	// opened kanban page (hidden) in the DOM, so document-wide lookups can hit a
	// stale board and break board switching / the queue filter.
	const root = context.page?.wrapper?.[0] || document;

	// The "Filters" button toggles the collapsible filter area (which holds the
	// "Select Kanban" switcher). page.js collapses that area for EVERY Project
	// kanban URL, so the button must exist on every Project board — otherwise the
	// user can't reopen filters to switch boards.
	const addFiltersButton = () => {
		const containers = root.querySelectorAll('div.page-head.flex > div > div > div.flex.col.page-actions.justify-content-end');
		for (const container of containers) {
			if (container.querySelector('#btn_collapse_filters_area')) continue;
			const custom_button_filter = document.createElement('button');
			custom_button_filter.setAttribute('id', 'btn_collapse_filters_area');
			custom_button_filter.classList.add('btn', 'btn-primary', 'btn-sm');
			custom_button_filter.setAttribute('type', 'button');
			custom_button_filter.setAttribute('data-toggle', 'collapse');
			custom_button_filter.setAttribute('data-target', '#collapse_filters_area');
			custom_button_filter.setAttribute('aria-expanded', 'false');
			custom_button_filter.setAttribute('aria-controls', 'collapse_filters_area');
			custom_button_filter.innerText = 'Filters';
			container.append(custom_button_filter);
		}
	};

	// The queue filter, preview/colour controls and freeze-queue toggle are only
	// meaningful on the workshop kanban (the Project "status" board). Other Project
	// boards (e.g. "Parts", "Remote Diagnose") get only the Filters button.
	if (!frappe.views.is_workshop_kanban(context.board_name)) {
		setTimeout(addFiltersButton, 1500);
		return;
	}

	const { auto_move_paused } = await frappe.db.get_doc('Queue Settings')

	if (!document.getElementById('kanban-toolbar-toggle-style')) {
		const style = document.createElement('style');
		style.id = 'kanban-toolbar-toggle-style';
		style.textContent = `
			.kanban-toolbar-toggles {
				display: inline-flex;
				align-items: center;
				gap: 2px;
				background: var(--bg-light-gray, #f4f5f6);
				border: 1px solid var(--border-color, #e2e6e9);
				border-radius: 6px;
				padding: 3px 4px;
				margin-right: 6px;
			}
			.kanban-toggle-switch {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				cursor: pointer;
				font-size: 11px;
				font-weight: 500;
				color: var(--text-muted, #8d99a6);
				white-space: nowrap;
				user-select: none;
				padding: 3px 7px;
				border-radius: 4px;
				transition: background 0.15s, color 0.15s;
			}
			.kanban-toggle-switch:hover {
				background: rgba(0,0,0,0.05);
				color: var(--text-color, #333);
			}
			.kanban-toggle-switch input[type="checkbox"] {
				display: none;
			}
			.kanban-toggle-track {
				width: 26px;
				height: 14px;
				background: #c8d0d8;
				border-radius: 7px;
				position: relative;
				transition: background 0.2s;
				flex-shrink: 0;
			}
			.kanban-toggle-track::after {
				content: '';
				position: absolute;
				top: 2px;
				left: 2px;
				width: 10px;
				height: 10px;
				background: white;
				border-radius: 50%;
				transition: left 0.15s;
				box-shadow: 0 1px 2px rgba(0,0,0,0.25);
			}
			.kanban-toggle-switch input:checked ~ .kanban-toggle-track {
				background: var(--primary, #5e64ff);
			}
			.kanban-toggle-switch input:checked ~ .kanban-toggle-track::after {
				left: 14px;
			}
			.kanban-toggle-switch input:checked ~ .kanban-toggle-label {
				color: var(--text-color, #333);
			}
			.kanban-controls-bar {
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 5px 12px;
				background: var(--fg-color, #fff);
				border-bottom: 1px solid var(--border-color, #e2e6e9);
				flex-shrink: 0;
			}
			.kanban-queue-filter-group {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				background: var(--bg-light-gray, #f4f5f6);
				border: 1px solid var(--border-color, #e2e6e9);
				border-radius: 6px;
				padding: 3px 8px;
				margin-right: 6px;
			}
			.kanban-queue-filter-label {
				font-size: 11px;
				font-weight: 500;
				color: var(--text-muted, #8d99a6);
				white-space: nowrap;
			}
			.kanban-queue-filter-select {
				font-size: 11px;
				font-weight: 500;
				border: none;
				background: transparent;
				color: var(--text-color, #333);
				cursor: pointer;
				outline: none;
				padding: 1px 2px;
				border-radius: 4px;
			}
			.kanban-queue-filter-select:hover {
				background: rgba(0,0,0,0.05);
			}
			.kanban-color-legend {
				display: inline-flex;
				align-items: center;
				flex-wrap: wrap;
				gap: 4px 10px;
				background: var(--bg-light-gray, #f4f5f6);
				border: 1px solid var(--border-color, #e2e6e9);
				border-radius: 6px;
				padding: 3px 8px;
			}
			.kanban-color-legend-title {
				font-size: 11px;
				font-weight: 500;
				color: var(--text-muted, #8d99a6);
				white-space: nowrap;
			}
			.kanban-legend-item {
				display: inline-flex;
				align-items: center;
				gap: 4px;
				font-size: 11px;
				font-weight: 500;
				color: var(--text-color, #333);
				white-space: nowrap;
			}
			.kanban-legend-swatch {
				width: 12px;
				height: 12px;
				border-radius: 3px;
				border: 1px solid rgba(0,0,0,0.15);
				flex-shrink: 0;
			}
			.kanban.queue-filter-position .kanban-column[data-column-value="In queue"] .kanban-card-wrapper:has(.circle-position.has-appointment) {
				display: none;
			}
			.kanban.queue-filter-appointment .kanban-column[data-column-value="In queue"] .kanban-card-wrapper:not(:has(.circle-position.has-appointment)) {
				display: none;
			}
		`;
		document.head.appendChild(style);
	}

	function applyQueueColumnFilter(value) {
		const kanban = root.querySelector('.kanban');
		if (!kanban) return;
		kanban.classList.remove('queue-filter-position', 'queue-filter-appointment');
		if (value === 'position') kanban.classList.add('queue-filter-position');
		if (value === 'appointment') kanban.classList.add('queue-filter-appointment');
	}

	setTimeout(() => {
		// `root` (scoped to this board's page wrapper) guards against the cached
		// pages of other boards: a global lookup would find a leftover controls
		// bar / Filters button from another board and bail out here, leaving this
		// board without its Filters button — which is what lets the user switch
		// kanban boards again.
		// Always keep the Filters button in the page-actions area.
		addFiltersButton();

		if (root.querySelector('#kanban-controls-bar')) return;

		function makeToggle(id, text, checked, tooltip) {
			const label = document.createElement('label');
			label.className = 'kanban-toggle-switch';
			label.id = id;
			if (tooltip) {
				label.setAttribute('title', tooltip);
			}
			const input = document.createElement('input');
			input.type = 'checkbox';
			if (checked) input.checked = true;
			const track = document.createElement('span');
			track.className = 'kanban-toggle-track';
			const textSpan = document.createElement('span');
			textSpan.className = 'kanban-toggle-label';
			textSpan.textContent = text;
			label.appendChild(input);
			label.appendChild(track);
			label.appendChild(textSpan);
			return { label, input };
		}

		// Controls bar injected above the kanban board (not inside the page-head)
		const controlsBar = document.createElement('div');
		controlsBar.id = 'kanban-controls-bar';
		controlsBar.className = 'kanban-controls-bar';

		// Queue column filter dropdown
		const queueFilterGroup = document.createElement('div');
		queueFilterGroup.className = 'kanban-queue-filter-group';

		const queueFilterLbl = document.createElement('span');
		queueFilterLbl.className = 'kanban-queue-filter-label';
		queueFilterLbl.textContent = 'Queue:';

		const queueFilterSelect = document.createElement('select');
		queueFilterSelect.id = 'queue-col-filter';
		queueFilterSelect.className = 'kanban-queue-filter-select';
		[
			{ value: 'all', label: 'All' },
			{ value: 'position', label: 'Queue position' },
			{ value: 'appointment', label: 'Fixed appointment' },
		].forEach(({ value, label }) => {
			queueFilterSelect.appendChild(new Option(label, value));
		});
		const savedQueueFilter = localStorage.getItem('kanban_queue_col_filter') || 'all';
		queueFilterSelect.value = savedQueueFilter;
		applyQueueColumnFilter(savedQueueFilter);
		queueFilterSelect.addEventListener('change', (event) => {
			const value = event.target.value;
			localStorage.setItem('kanban_queue_col_filter', value);
			applyQueueColumnFilter(value);
		});

		queueFilterGroup.appendChild(queueFilterLbl);
		queueFilterGroup.appendChild(queueFilterSelect);

		// Boolean toggles group
		const toggleGroup = document.createElement('div');
		toggleGroup.className = 'kanban-toolbar-toggles';

		const { label: previewLabel, input: previewInput } = makeToggle('show-preview', 'Preview', context.board.show_preview_card, 'Show or hide card previews (images/details) on the Kanban board');
		previewInput.addEventListener('change', (event) => {
			const isChecked = event.target.checked;
			frappe.db.set_value('Kanban Board', context.board.name, 'show_preview_card', Number(isChecked))
			window.location.reload()
		})

		const { label: freezeLabel, input: freezeInput } = makeToggle('queue-freeze', 'Freeze queue', auto_move_paused, 'Prevent queue cards from moving automatically when marked as completed');
		freezeInput.addEventListener('change', (event) => {
			const isChecked = event.target.checked;
			if (isChecked) {
				showConfirmationDialog(freezeInput)
				return
			} else {
				showDeactivateFreezeDialog(freezeInput);
				return
			}
		})

		toggleGroup.appendChild(previewLabel);
		toggleGroup.appendChild(freezeLabel);

		// Color legend / glossary for the job-type card colors
		const colorLegend = document.createElement('div');
		colorLegend.className = 'kanban-color-legend';

		const legendTitle = document.createElement('span');
		legendTitle.className = 'kanban-color-legend-title';
		legendTitle.textContent = 'Type of job:';
		colorLegend.appendChild(legendTitle);

		[
			{ label: 'Diagnose', color: '#bfdbfe' },
			{ label: 'Reparatie', color: '#fed7aa' },
			{ label: 'Oliewissel', color: '#fef08a' },
			{ label: 'Overig', color: '#ddd6fe' },
			{ label: 'Software', color: '#a5f3fc' },
			{ label: 'Parts', color: '#a7f3d0' },
			{ label: 'Other', color: '#e5e7eb' },
		].forEach(({ label, color }) => {
			const item = document.createElement('span');
			item.className = 'kanban-legend-item';
			const swatch = document.createElement('span');
			swatch.className = 'kanban-legend-swatch';
			swatch.style.backgroundColor = color;
			const text = document.createElement('span');
			text.textContent = label;
			item.appendChild(swatch);
			item.appendChild(text);
			colorLegend.appendChild(item);
		});

		controlsBar.appendChild(queueFilterGroup);
		controlsBar.appendChild(toggleGroup);
		controlsBar.appendChild(colorLegend);

		// Insert the controls bar before the .kanban element so it sits between the header and the board
		const kanbanEl = root.querySelector('.kanban');
		if (kanbanEl) {
			kanbanEl.parentNode.insertBefore(controlsBar, kanbanEl);
		}
	}, 1500);
}
function showConfirmationDialog(input) {
	const dialog = new frappe.ui.Dialog({
		title: 'Confirm',
		fields: [
			{
				fieldtype: 'HTML',
				options: '<p>If you enable the freeze queue position process, job cards will not move even if they are marked as completed.</p>'
			},
			{
				fieldtype: 'HTML',
				options: 'Do you want to continue?'
			}
		],
		primary_action_label: 'Confirm',
		primary_action: function () {
			dialog.hide();
			frappe.db.set_value('Queue Settings', 'Queue Settings', 'auto_move_paused', 1).then(res => {
				const warn_dialog = frappe.warn('Status updated successfully', 'Would you like to send a WhatsApp message to notify the clients in the queue?',
					async () => {
						const { aws_url } = await frappe.db.get_doc('Queue Settings')
						return frappe.call({
							method: "frappe.desk.doctype.kanban_board.kanban_board.call_freeze_queue_position_message",
							args: { aws_url: aws_url },
							callback: (result) => {
								console.log("message queue position freeze sent: ", result);
							},
						});
					},
					'Yes',
					true // Sets dialog as minimizable
				)
				// frappe.warn's secondary button defaults to "Cancel"; relabel it to "No"
				// for clarity since this is a Yes/No question.
				warn_dialog.set_secondary_action_label(__('No'));
			})
		},
		secondary_action_label: 'No',
		secondary_action: function () {
			input.checked = false
			dialog.hide();
		}
	});

	dialog.$wrapper.find('.modal-header .modal-actions').hide();
	dialog.$wrapper.modal({ backdrop: 'static', keyboard: false })

	dialog.show();
}

function showDeactivateFreezeDialog(input) {
	const dialog = new frappe.ui.Dialog({
		title: 'Reorder Queue',
		fields: [
			{
				fieldtype: 'HTML',
				options: `
					<div style="font-size: 14px; line-height: 1.5; margin-bottom: 10px;">
						<p style="font-size: 15px; font-weight: bold;">Do you want to reorder the queue?</p>
						<p><strong>YES:</strong> The queue will be reorganized immediately.</p>
						<p><strong>NO:</strong> The system will automatically check and organize it tonight (the daily automatic process).</p>
					</div>
				`
			}
		],
		primary_action_label: 'YES',
		primary_action: async function () {
			dialog.hide();
			frappe.db.set_value('Queue Settings', 'Queue Settings', 'auto_move_paused', 0).then(async () => {
				frappe.show_alert({
					message: __('Deactivating freeze and reordering queue...'),
					indicator: 'blue'
				});
				const { aws_url } = await frappe.db.get_doc('Queue Settings');
				const endpoint = aws_url ? (aws_url.endsWith('/') ? aws_url + 'queue/reorder' : aws_url + '/queue/reorder') : '/queue/reorder';
				fetch(endpoint, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Frappe-CSRF-Token': frappe.csrf_token || ''
					}
				})
					.then(response => {
						if (response.ok) {
							frappe.show_alert({
								message: __('Queue reordered successfully.'),
								indicator: 'green'
							});
						} else {
							frappe.show_alert({
								message: __('Failed to reorder queue.'),
								indicator: 'red'
							});
						}
					})
					.catch(err => {
						console.error(err);
						frappe.show_alert({
							message: __('Error reordering queue.'),
							indicator: 'red'
						});
					});
			});
		},
		secondary_action_label: 'NO',
		secondary_action: function () {
			dialog.hide();
			frappe.db.set_value('Queue Settings', 'Queue Settings', 'auto_move_paused', 0).then(() => {
				frappe.show_alert({
					message: __('Freeze queue deactivated. The system will automatically organize the queue tonight.'),
					indicator: 'green'
				});
			});
		}
	});

	// If the user cancels the modal through other means (like escape or clicking close icon), revert checkbox to checked.
	dialog.on_cancel = function () {
		input.checked = true;
	};

	// We can also add a subtle "Cancel" button to let the user keep the freeze active
	dialog.add_custom_action('Cancel', function () {
		input.checked = true;
		dialog.hide();
	});

	dialog.$wrapper.find('.modal-header .modal-actions').hide();
	dialog.$wrapper.modal({ backdrop: 'static', keyboard: false });
	dialog.show();
}

