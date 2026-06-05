// TODO: Refactor for better UX

import { createStore } from "vuex";
frappe.provide("frappe.views");

const ProjectStatusOptions = {
	InQueue: "In queue",
	InParking: "In parking",
	PreDiagnose: "Pre-diagnose",
	Diagnosed: "Diagnosed",
	Quoted: "Quoted",
	QuoteApproved: "Quote approved",
	InRepair: "In repair",
	RepairReady: "Repair ready",
	QualityCheckApproved: "Quality check approved",
	FullyTestedAdapted: "Fully-tested/adapted",
	InvoicePaid: "Invoice paid",
	AwaitingPickup: "Awaiting pickup",
	Completed: "Completed",
	Cancelled: "Cancelled",
	InPause: "In pause",
	NoResponseFromCustomer: "No response from customer",
	RequestCallback: "Request a callback",
	RemoteDiagnose: "Remote diagnose",
	SoftShowroom: "Soft. showroom",
	SoftInternally: "Soft. internally"
};

const KanbanSize = {
	small: "small",
	medium: "medium",
	large: "large"
};

const zoomLevels = {
	1: 'small',
	2: 'medium',
	3: 'large'
};

const columnsByMechanic = {
	"In queue": "In queue",
	"In parking": "In parking",
	"Quoted": "Quoted",
	"Quote approved": "Quote approved",
	"In repair": "In repair",
	"Repair ready": "Repair ready",
};

(function () {
	let kanban_size = KanbanSize.large
	let same_status_2days = "2 days w/o update"
	let quotations_draft = 0
	let unread_conversations = []
	var method_prefix = "frappe.desk.doctype.kanban_board.kanban_board.";

	// Conversation cache — invalidated after 30 s or on Conversation realtime event
	const _convCache = { lastMessage: null, unread: null, ts: 0 };
	const CONV_TTL_MS = 30_000;
	function _convCacheValid() { return Date.now() - _convCache.ts < CONV_TTL_MS; }
	function _invalidateConvCache() { _convCache.ts = 0; }

	let columns_unwatcher = null;
	let store;
	let mouseLeaveTimeout;

	const init_store = () => {
		store = createStore({
			state: {
				doctype: "",
				board: {},
				card_meta: {},
				cards: [],
				columns: [],
				filters_modified: false,
				cur_list: {},
				empty_state: true,
				done_statuses: ['Completed', 'In pause', 'Cancelled', 'Quality check approved', 'No response from customer', 'Invoice paid', 'Awaiting pickup'],
				kanban_columns: [],
				kanban_size_range: null,
				is_dragging: false
			},
			mutations: {
				set_dragging(state, is_dragging) {
					state.is_dragging = is_dragging;
				},
				update_state(state, obj) {
					Object.assign(state, obj);
				},
			},
			actions: {
				init: async function (context, opts) {
					context.commit("update_state", {
						empty_state: true,
					});
					var board = opts.board;
					var card_meta = opts.card_meta;
					opts.card_meta = card_meta;
					opts.board = board;
					var cards = []
					let phone_numbers = opts.cards.map(card => card.custom_customers_phone_number)
					phone_numbers = new Set(phone_numbers)
					const conversations = await last_message_from_customer(phone_numbers)

					for (const card of opts.cards) {
						const customer_responded = conversations.includes(card.custom_customers_phone_number)
						cards.push(prepare_card(card, opts, null, customer_responded))
					}
					var columns = prepare_columns(board.columns);
					context.commit("update_state", {
						doctype: opts.doctype,
						board: board,
						card_meta: card_meta,
						cards: cards,
						columns: columns,
						cur_list: opts.cur_list,
						empty_state: false,
						wrapper: opts.wrapper,
					});
				},
				update_cards: async function (context, cards) {
					await getUnreadConversations()
					var state = context.state;
					var prepared_cards = []
					let phone_numbers = cards.map(card => card.custom_customers_phone_number)
					phone_numbers = new Set(phone_numbers)
					const conversations = await last_message_from_customer(phone_numbers)

					for (const card of cards) {
						const customer_responded = conversations.includes(card.custom_customers_phone_number)
						prepared_cards.push(prepare_card(card, state, null, customer_responded))
					}

					var _cards = [].concat(
						...prepared_cards,
						...state.cards
					).uniqBy((el) => el.name)

					context.commit("update_state", {
						cards: _cards,
					});
				},
				add_column: function (context, col) {
					if (frappe.model.can_create("Custom Field")) {
						store.dispatch("update_column", { col, action: "add" });
					} else {
						frappe.msgprint({
							title: __("Not permitted"),
							message: __("You are not allowed to create columns"),
							indicator: "red",
						});
					}
				},
				archive_column: function (context, col) {
					store.dispatch("update_column", { col, action: "archive" });
				},
				restore_column: function (context, col) {
					store.dispatch("update_column", { col, action: "restore" });
				},
				update_column: function (context, { col, action }) {
					var doctype = context.state.doctype;
					var board = context.state.board;
					fetch_customization(doctype)
						.then(function (doc) {
							return modify_column_field_in_c11n(doc, board, col.title, action);
						})
						.then(save_customization)
						.then(function () {
							return update_kanban_board(board.name, col.title, action);
						})
						.then(
							function (r) {
								var cols = r.message;
								context.commit("update_state", {
									columns: prepare_columns(cols, context.state.cards),
								});
							},
							function (err) {
								console.error(err);
							}
						);
				},
				add_card: function (context, { card_title, column_title }) {
					var state = context.state;
					var doc = frappe.model.get_new_doc(state.doctype);
					var field = state.card_meta.title_field;
					var quick_entry = state.card_meta.quick_entry;

					var doc_fields = {};
					doc_fields[field.fieldname] = card_title;
					doc_fields[state.board.field_name] = column_title;
					state.cur_list.filter_area.get().forEach(function (f) {
						if (f[2] !== "=") return;
						doc_fields[f[1]] = f[3];
					});

					$.extend(doc, doc_fields);

					// add the card directly
					// for better ux
					const card = prepare_card(doc, state);
					card._disable_click = true;
					const cards = [...state.cards, card];
					// remember the name which we will override later
					const old_name = doc.name;
					context.commit("update_state", { cards });

					if (field && !quick_entry) {
						return insert_doc(doc).then(function (r) {
							// update the card in place with the updated doc
							const updated_doc = r.message;
							const index = state.cards.findIndex((card) => card.name === old_name);
							const card = prepare_card(updated_doc, state);
							const new_cards = state.cards.slice();
							new_cards[index] = card;
							context.commit("update_state", { cards: new_cards });
							const args = {
								new: 1,
								name: card.name,
								colname: updated_doc[state.board.field_name],
							};
							store.dispatch("update_order_for_single_card", args);
						});
					} else {
						frappe.new_doc(state.doctype, doc);
					}
				},
				update_card: function (context, card) {
					var index = -1;
					context.state.cards.forEach(function (c, i) {
						if (c.name === card.name) {
							index = i;
						}
					});
					var cards = context.state.cards.slice();
					if (index !== -1) {
						cards.splice(index, 1, card);
					}
					context.commit("update_state", { cards: cards });
				},
				update_order_for_single_card: function (context, card) {
					// cache original order
					const _cards = context.state.cards.slice();
					const _columns = context.state.columns.slice();

					let args = {};
					let method_name = "";

					if (card.new) {
						method_name = "add_card";
						args = {
							board_name: context.state.board.name,
							docname: card.name,
							colname: card.colname,
						};
					} else {
						method_name = "update_order_for_single_card";
						args = {
							board_name: context.state.board.name,
							docname: card.name,
							from_colname: card.from_colname,
							to_colname: card.to_colname,
							old_index: card.old_index,
							new_index: card.new_index,
						};
					}
					if (args.from_colname === args.to_colname) {
						context.commit("update_state", {
							cards: _cards,
							columns: _columns,
						});
						frappe.dom.unfreeze();
						return;
					}
					frappe.dom.freeze();
					frappe
						.call({
							method: method_prefix + method_name,
							args: args,
							callback: (r) => {
								let board = r.message;
								let updated_cards = [
									{ name: card.name, column: card.to_colname || card.colname },
								];
								let cards = update_cards_column(updated_cards);
								context.commit("update_state", {
									cards: cards,
								});
								store.dispatch("update_order");
								frappe.dom.unfreeze();
							},
						})
						.fail(function () {
							// revert original order
							context.commit("update_state", {
								cards: _cards,
								columns: _columns,
							});
							frappe.dom.unfreeze();
						});
				},
				update_order: function (context) {
					// cache original order
					const _cards = context.state.cards.slice();
					const _columns = context.state.columns.slice();

					const order = {};
					context.state.wrapper.find(".kanban-column[data-column-value]").each(function () {
						var col_name = $(this).data().columnValue;
						order[col_name] = [];
						$(this)
							.find(".kanban-card-wrapper")
							.each(function () {
								var card_name = decodeURIComponent($(this).data().name);
								order[col_name].push(card_name);
							});
					});

					frappe
						.call({
							method: method_prefix + "update_order",
							args: {
								board_name: context.state.board.name,
								order: order,
							},
							callback: (r) => {
								var board = r.message[0];
								var updated_cards = r.message[1];
								var cards = update_cards_column(updated_cards);
								var columns = prepare_columns(board.columns);
								context.commit("update_state", {
									cards: cards,
									columns: columns,
								});
							},
						})
						.fail(function () {
							// revert original order
							context.commit("update_state", {
								cards: _cards,
								columns: _columns,
							});
						});
				},
				update_column_order: function (context, order) {
					return frappe
						.call({
							method: method_prefix + "update_column_order",
							args: {
								board_name: context.state.board.name,
								order: order,
							},
						})
						.then(function (r) {
							var board = r.message;
							var columns = prepare_columns(board.columns);
							context.commit("update_state", {
								columns: columns,
							});
						});
				},
				set_indicator: function (context, { column, color }) {
					return frappe
						.call({
							method: method_prefix + "set_indicator",
							args: {
								board_name: context.state.board.name,
								column_name: column.title,
								indicator: color,
							},
						})
						.then(function (r) {
							var board = r.message;
							var columns = prepare_columns(board.columns, context.state.cards);
							context.commit("update_state", {
								columns: columns,
							});
						});
				},
				get_cards_count_by_column: function (context) {
					if (context.state.doctype === "Project") {
						const _cards = context.state.cards
						let countByColumn = {};
						_cards.forEach(card => {
							let column = card.column;
							if (countByColumn[column]) {
								countByColumn[column]++;
							} else {
								countByColumn[column] = 1;
							}
						});
						return countByColumn;
					} else return ''
				},
				update_kanban_size_range: function (context, value) {
					context.state.kanban_size_range = value
				},
			},
		});

	}

	frappe.views.KanbanBoard = function (opts) {

		var self = {};
		self.wrapper = opts.wrapper;
		self.cur_list = opts.cur_list;
		self.board_name = opts.board_name;
		self.board_perms = self.cur_list.board_perms;

		self.update = function (cards) {
			// update cards internally
			opts.cards = cards;

			if (self.wrapper.find(".kanban").length > 0 && self.cur_list.start !== 0) {
				store.dispatch("update_cards", cards);
			} else {
				init();
			}
		};

		self.update_cards = function (cards) {
			store.dispatch("update_cards", cards);
		}

		self.update_columns = function () {
			make_columns()
		}

		async function init() {

			await getUnreadConversations()

			init_store();

			store.dispatch("init", opts);

			columns_unwatcher && columns_unwatcher();

			store.watch((state) => {
				return state.columns
			}, make_columns);

			prepare();

			const user_kanban_size = await get_kanban_size_by_user(store)
			kanban_size = user_kanban_size

			make_columns();

			store.watch((state) => {
				return state.cur_list;
			}, setup_restore_columns);

			columns_unwatcher = store.watch((state) => {
				return state.columns;
			}, setup_restore_columns);

			store.watch((state) => {
				return state.empty_state;
			}, show_empty_state);

			store.watch((state) => {
				update_kanban_size(state.kanban_size_range)
				return state.kanban_size_range
			})

			store.dispatch('update_order')

			console.log("kanban board initialized")
			render_scroll_box();
		}

		function render_scroll_box() {
			// Ensure container is relative for absolute positioning of the box
			if (self.wrapper.css('position') === 'static') {
				self.wrapper.css('position', 'relative');
			}

			let toggle_btn = self.wrapper.find('.kanban-scroll-toggle');
			if (!toggle_btn.length) {
				toggle_btn = $('<div class="kanban-scroll-toggle"><i class="fa fa-chevron-left"></i></div>');
				self.wrapper.append(toggle_btn);
			}

			let scroll_box = self.wrapper.find('.kanban-scroll-box');
			if (!scroll_box.length) {
				scroll_box = $('<div class="kanban-scroll-box"></div>');
				self.wrapper.append(scroll_box);
			}

			// Clear previous content
			scroll_box.empty();

			// Get the scrollable container.
			// self.$kanban_board is the .kanban div which is scrollable
			const wrapperEl = self.$kanban_board.get(0);
			const $wrapper = self.$kanban_board;

			// Add rectangles for each column
			// accessing store.state.columns which should be populated by now or watcher will handle?
			// The original logic iterated this.board.columns. 
			// Here we can use store.state.columns
			if (store.state.columns) {
				store.state.columns.forEach(col => {
					if (col.status !== 'Archived') {
						scroll_box.append('<div class="kanban-scroll-box-rect"></div>');
					}
				});
			}

			// Add draggable tracker
			let tracker = $('<div class="kanban-scroll-tracker"></div>');
			scroll_box.append(tracker);

			// --- Sync Logic ---

			const updateTrackerDimensions = () => {
				if (!wrapperEl) return;
				const totalWidth = wrapperEl.scrollWidth;
				const visibleWidth = wrapperEl.clientWidth;
				const scrollBoxWidth = scroll_box.width(); // Should be 150px

				if (totalWidth <= visibleWidth) {
					tracker.width(scrollBoxWidth);
					tracker.css('left', 0);
					return;
				}

				// Calculate proportional width
				let trackerWidth = (visibleWidth / totalWidth) * scrollBoxWidth;
				// Enforce min width so it remains grabable
				if (trackerWidth < 10) trackerWidth = 10;
				tracker.width(trackerWidth);

				// Sync position
				const maxScroll = totalWidth - visibleWidth;
				const maxTrackerLeft = scrollBoxWidth - trackerWidth;
				const scrollRatio = wrapperEl.scrollLeft / maxScroll;

				tracker.css('left', (scrollRatio * maxTrackerLeft) + 'px');
			};

			// 1. Sync Scroll -> Tracker
			// Use namespace to allow easy removal
			$wrapper.off('scroll.kanbanTracker').on('scroll.kanbanTracker', () => {
				if (isDragging) return; // Don't fight drag
				updateTrackerDimensions();
			});

			// 2. Sync Resize -> Tracker
			// Use ResizeObserver for robust detection of wrapper changes
			const resizeObserver = new ResizeObserver(() => {
				updateTrackerDimensions();
			});
			if (wrapperEl) {
				resizeObserver.observe(wrapperEl);
			}
			// Also window resize for good measure
			$(window).off('resize.kanbanTracker').on('resize.kanbanTracker', updateTrackerDimensions);

			// Initial Call
			// Use setTimeout to allow potential layout settle
			setTimeout(updateTrackerDimensions, 100);

			// 3. Sync Drag -> Scroll
			let isDragging = false;
			let startX;
			let initialLeft;

			const onStart = (clientX) => {
				isDragging = true;
				startX = clientX;
				initialLeft = tracker.position().left;
				tracker.css('cursor', 'grabbing');
			};

			const onMove = (clientX) => {
				if (!isDragging) return;

				// Re-calculate dimensions in case it changed
				const maxTrackerLeft = scroll_box.width() - tracker.outerWidth();

				let deltaX = clientX - startX;
				let newLeft = initialLeft + deltaX;

				// Constrain
				if (newLeft < 0) newLeft = 0;
				if (newLeft > maxTrackerLeft) newLeft = maxTrackerLeft;

				tracker.css('left', newLeft + 'px');

				// Drive Scroll
				const totalWidth = wrapperEl.scrollWidth;
				const visibleWidth = wrapperEl.clientWidth;
				const maxScroll = totalWidth - visibleWidth;

				if (maxScroll > 0 && maxTrackerLeft > 0) {
					const ratio = newLeft / maxTrackerLeft;
					wrapperEl.scrollLeft = ratio * maxScroll;
				}
			};

			const onEnd = () => {
				if (isDragging) {
					isDragging = false;
					tracker.css('cursor', 'grab');
				}
			};

			// Mouse Events
			tracker.on('mousedown', (e) => {
				onStart(e.clientX);
				e.preventDefault();
			});

			$(document).on('mousemove.kanbanTracker', (e) => {
				onMove(e.clientX);
			});

			$(document).on('mouseup.kanbanTracker', () => {
				onEnd();
			});

			// Touch Events
			tracker.on('touchstart', (e) => {
				const touch = e.originalEvent.touches[0];
				onStart(touch.clientX);
				// e.preventDefault(); // Sometimes needed, but might interfere with scrolling if not dragging? 
				// Since we are dragging the tracker, we probably want to prevent default scroll behavior of the page
				// e.preventDefault(); 
			});

			$(document).on('touchmove.kanbanTracker', (e) => {
				if (isDragging) {
					const touch = e.originalEvent.touches[0];
					onMove(touch.clientX);
					//e.preventDefault(); // Prevent page scrolling while dragging tracker
				}
			});

			$(document).on('touchend.kanbanTracker', () => {
				onEnd();
			});

			toggle_btn.off('click').on('click', (e) => {
				e.stopPropagation();
				scroll_box.toggleClass('collapsed');
				toggle_btn.toggleClass('collapsed');
				const is_collapsed = scroll_box.hasClass('collapsed');
				toggle_btn.find('i').toggleClass('fa-chevron-left', !is_collapsed).toggleClass('fa-chevron-right', is_collapsed);
			});

			const style_id = "kanban-scroll-box-style";
			if (!$("#" + style_id).length) {
				const css = `
					.kanban, .kanban-board-wrapper {
						display: flex;
						flex-wrap: nowrap;
						overflow-x: auto;
					}
					.kanban-scroll-box {
						position: absolute;
						bottom: -3%;
						left: 40px;
						width: 150px;
						height: 50px;
						background-color: white;
						z-index: 999;
						display: flex;
						flex-direction: row;
						justify-content: space-evenly;
						padding: 4px;
						border: 0.5px solid black;
						transition: transform 0.3s ease, opacity 0.3s ease;
					}
					.kanban-scroll-box.collapsed {
						transform: translateX(-200px);
						opacity: 0;
						pointer-events: none;
					}
					.kanban-scroll-toggle {
						position: absolute;
						bottom: -3%;
						left: 0px;
						width: 30px;
						height: 50px;
						background-color: #f0f0f0;
						z-index: 1000;
						display: flex;
						align-items: center;
						justify-content: center;
						cursor: pointer;
						border: 0.5px solid black;
						border-radius: 4px 0 0 4px;
						transition: left 0.3s ease;
					}
					.kanban-scroll-toggle:hover {
						background-color: #e0e0e0;
					}
					.kanban-scroll-box-rect {
						width: 4px;
						height: 100%;
						background-color: #c7c7c7;
						border-radius: 2px;
					}
					.kanban-scroll-tracker {
						position: absolute;
						top: 0;
						height: 100%;
						/* width set dynamically */
						border: 2px solid blue;
						background-color: transparent;
						cursor: grab;
						box-sizing: border-box;
					}
				`;
				$(`<style id="${style_id}">`).prop("type", "text/css").html(css).appendTo("head");
			}
		}

		function prepare() {
			self.$kanban_board = self.wrapper.find(".kanban");

			if (self.$kanban_board.length === 0) {
				self.$kanban_board = $(frappe.render_template("kanban_board"));
				self.$kanban_board.appendTo(self.wrapper);
			}
			self.$filter_area = self.cur_list.$page.find(".active-tag-filters");
			bind_events();
			setup_sortable();
			setup_zoom_component()
		}

		async function make_columns() {
			self.$kanban_board.find(".kanban-column").not(".add-new-column").remove();
			var columns = store.state.columns;
			const counter_cards_by_columns = await store.dispatch('get_cards_count_by_column')
			columns.filter(is_active_column).map(function (col) {
				frappe.views.KanbanBoardColumn({ ...col, title: col.title }, self.$kanban_board, self.board_perms, counter_cards_by_columns);
			});
		}

		function bind_events() {
			bind_add_column();
			bind_clickdrag();
		}

		function setup_sortable() {
			// If no write access to board, editing board (by dragging column) should be blocked
			// if (!self.board_perms.write) return;
			// console.log(self.$kanban_board.get(0))
			// var sortable = new Sortable(self.$kanban_board.get(0), {
			// 	group: "columns",
			// 	animation: 150,
			// 	dataIdAttr: "data-column-value",
			// 	filter: ".add-new-column",
			// 	handle: ".kanban-column-title",
			// 	onEnd: function () {
			// 		var order = sortable.toArray();
			// 		order = order.slice(1);
			// 		store.dispatch("update_column_order", order);
			// 	},
			// });
		}

		function bind_add_column() {
			if (!self.board_perms.write) {
				// If no write access to board, editing board (by adding column) should be blocked
				self.$kanban_board.find(".add-new-column").remove();
				return;
			}

			var $add_new_column = self.$kanban_board.find(".add-new-column"),
				$compose_column = $add_new_column.find(".compose-column"),
				$compose_column_form = $add_new_column.find(".compose-column-form").hide();

			$compose_column.on("click", function () {
				$(this).hide();
				$compose_column_form.show();
				$compose_column_form.find("input").focus();
			});

			//save on enter
			$compose_column_form.keydown(function (e) {
				if (e.which == 13) {
					e.preventDefault();
					if (!frappe.request.ajax_count) {
						// not already working -- double entry
						var title = $compose_column_form.serializeArray()[0].value;
						var col = {
							title: title.trim(),
						};
						store.dispatch("add_column", col);
						$compose_column_form.find("input").val("");
						$compose_column.show();
						$compose_column_form.hide();
					}
				}
			});

			// on form blur
			$compose_column_form.find("input").on("blur", function () {
				$(this).val("");
				$compose_column.show();
				$compose_column_form.hide();
			});
		}

		function bind_clickdrag() {
			let isDown = false;
			let startX;
			let scrollLeft;
			let draggable = self.$kanban_board[0];

			draggable.addEventListener("mousedown", (e) => {
				// don't trigger scroll if one of the ancestors of the
				// clicked element matches any of these selectors
				let ignoreEl = [
					".kanban-column .kanban-column-header",
					".kanban-column .add-card",
					".kanban-column .kanban-card.new-card-area",
					".kanban-card-wrapper",
				];
				if (ignoreEl.some((el) => e.target.closest(el))) return;

				isDown = true;
				draggable.classList.add("clickdrag-active");
				startX = e.pageX - draggable.offsetLeft;
				scrollLeft = draggable.scrollLeft;
			});
			draggable.addEventListener("mouseleave", () => {
				isDown = false;
				draggable.classList.remove("clickdrag-active");
			});
			draggable.addEventListener("mouseup", () => {
				isDown = false;
				draggable.classList.remove("clickdrag-active");
			});
			draggable.addEventListener("mousemove", (e) => {
				if (!isDown) return;
				e.preventDefault();
				const x = e.pageX - draggable.offsetLeft;
				const walk = x - startX;
				draggable.scrollLeft = scrollLeft - walk;
			});
		}

		function setup_restore_columns() {
			var cur_list = store.state.cur_list;
			var columns = store.state.columns;
			var list_row_right = cur_list.$page
				.find(`[data-list-renderer='Kanban'] .list-row-right`)
				.css("margin-right", "15px");
			list_row_right.empty();

			var archived_columns = columns.filter(function (col) {
				return col.status === "Archived";
			});

			if (!archived_columns.length) return;

			var options = archived_columns.reduce(function (a, b) {
				return (
					a +
					`<li><a class='option'>" +
					"<span class='ellipsis' style='max-width: 100px; display: inline-block'>" +
					__(b.title) + "</span>" +
					"<button style='float:right;' data-column='" + b.title +
					"' class='btn btn-default btn-xs restore-column text-muted'>"
					+ __('Restore') + "</button></a></li>`
				);
			}, "");
			var $dropdown = $(
				"<div class='dropdown pull-right'>" +
				"<a class='text-muted dropdown-toggle' data-toggle='dropdown'>" +
				"<span class='dropdown-text'>" +
				__("Archived Columns") +
				"</span><i class='caret'></i></a>" +
				"<ul class='dropdown-menu'>" +
				options +
				"</ul>" +
				"</div>"
			);

			list_row_right.html($dropdown);

			$dropdown.find(".dropdown-menu").on("click", "button.restore-column", function () {
				var column_title = $(this).data().column;
				var col = {
					title: column_title,
					status: "Archived",
				};
				store.dispatch("restore_column", col);
			});
		}

		function show_empty_state() {
			var empty_state = store.state.empty_state;

			if (empty_state) {
				self.$kanban_board.find(".kanban-column").hide();
				self.$kanban_board.find(".kanban-empty-state").show();
			} else {
				self.$kanban_board.find(".kanban-column").show();
				self.$kanban_board.find(".kanban-empty-state").hide();
			}
		}

		function update_kanban_size(size) {
			kanban_size = size
		}

		init();

		return self;
	};

	frappe.views.KanbanBoardColumn = function (column, wrapper, board_perms, cards_by_columns = []) {
		var self = {};
		var filtered_cards = [];
		frappe.realtime.doctype_subscribe(this.doctype);
		frappe.realtime.off("kanban_project_refresh");
		frappe.realtime.on('kanban_project_refresh', () => {
			make_dom(true)
		});
		// Invalidate conversation cache when any Conversation doc changes
		frappe.realtime.on("list_update", (data) => {
			if (data?.doctype === "Conversation") _invalidateConvCache();
		});

		function init() {
			make_dom();
			setup_sortable();
			make_cards();
			store.watch((state, getters) => {
				return state.cards;
			}, () => {
				make_cards();
				refresh_column_counter();
			});
			bind_add_card();
			bind_options();
			get_and_set_columns_titles_with_counter()

		}

		function get_total_cards() {
			return cards_by_columns[column.title] ?? 0
		}

		function get_and_set_columns_titles_with_counter() {
			let _title = self.$kanban_column.find(".kanban-column-title")[0].outerText
			_title = _title + " (" + get_total_cards() + ")"
			store.state.kanban_columns.push(_title)
			self.$kanban_column.find(".kanban-column-title").html("<span class=\"kanban-title ellipsis\" title=\"" + _title + "\">" + _title + "</span>");
		}

		function refresh_column_counter() {
			if (store.state.doctype !== "Project") return;
			const $titleArea = self.$kanban_column.find(".kanban-column-title");
			if (!$titleArea.length) return;
			const count = store.state.cards.filter((c) => c.column === column.title).length;
			const newTitle = column.title + " (" + count + ")";
			$titleArea.html("<span class=\"kanban-title ellipsis\" title=\"" + newTitle + "\">" + newTitle + "</span>");
		}

		let loading = false
		function make_dom(call = false) {
			self.$kanban_column = $(
				frappe.render_template("kanban_column", {
					title: column.title,
					doctype: store.state.doctype,
					indicator: frappe.scrub(column.indicator, "-"),
					column_title: "column_" + column.title.toLowerCase().replace(/[\s\-\/]+/g, '_'),
					size_class: kanban_size
				})
			).appendTo(wrapper);
			self.$kanban_cards = self.$kanban_column.find(".kanban-cards");
			if (store.state.done_statuses.includes(column.title)) {
				self.$kanban_cards.on('scroll', (event) => {
					const { target: { scrollTop, clientHeight, scrollHeight, scrollLeft } } = event;
					if (loading) return
					if (Math.abs(scrollTop) > Math.abs(scrollLeft)) {
						if (scrollTop + clientHeight >= scrollHeight) {
							const start = store.state.cards.filter((el) => el.column === column.title).length
							loading = true;
							frappe.call({
								method: 'frappe.desk.reportview.get',
								args: {
									"doctype": "Project",
									"fields": store.state.cur_list.fields.map(f => Array.isArray(f) ? f[0] : f),
									"filters": [['status', '=', column.title]],
									"start": start,
									"page_length": 25,
									"view": "List",
									"group_by": "`tabProject`.`name`",
									"with_comment_count": 1
								}
							}).then((res) => {
								const data = frappe.utils.dict(res.message.keys, res.message.values)
								const newTotal = Number(start) + Number(res.message.values.length)
								store.dispatch("update_cards", data);
								loading = false;
								const kanbanTitle = self.$kanban_column.find(".kanban-title");
								kanbanTitle.remove();
								const newTitle = column.title + " (" + (newTotal) + ")";
								const newKanbanTitle = $("<span class=\"kanban-title ellipsis\" title=\"" + newTitle + "\">" + newTitle + "</span>");
								self.$kanban_column.find(".kanban-column-title").append(newKanbanTitle);
							}).catch(() => { loading = false; })
						}
					}
				})
			}
			if (call) {
				frappe.call({
					method: 'frappe.desk.reportview.get',
					args: {
						"doctype": "Project",
						"fields": store.state.cur_list.fields.map(f => Array.isArray(f) ? f[0] : f),
						"filters": [['status', '=', column.title]],
						"start": 0,
						"page_length": 25,
						"view": "List",
						"group_by": "`tabProject`.`name`",
						"with_comment_count": 1
					}
				}).then((res) => {
					const data = frappe.utils.dict(res.message.keys, res.message.values)
					store.dispatch("update_cards", data);
				})
			}
		}

		// Función para filtrar y ordenar los proyectos
		function filterAndSortProjects(cards) {
			return cards
				.filter(card => card.column !== 'In queue' && card.column !== 'In parking')
				// Ordenar los resultados por doc.modified (de más viejo a más nuevo)
				.sort((a, b) => new Date(a.status_modified) - new Date(b.status_modified));
		}



		function make_cards() {
			self.$kanban_cards.empty();
			var cards = store.state.cards;
			filtered_cards = get_cards_for_column(cards, column);

			var filtered_cards_names = filtered_cards.map((card) => card.name);

			const fragment = document.createDocumentFragment();
			const $fragment = $(fragment);

			var order = column.order;
			if (order && !store.state.done_statuses.includes(column.title)) {
				order = JSON.parse(order);
				// new cards
				filtered_cards.forEach(function (card) {
					if (order.indexOf(card.name) === -1) {
						frappe.views.KanbanBoardCard(card, $fragment);
					}
				});
				order.forEach(function (name) {
					if (!filtered_cards_names.includes(name)) return;
					frappe.views.KanbanBoardCard(get_card(name), $fragment);
				});
			} else {
				filtered_cards.forEach(function (card) {
					frappe.views.KanbanBoardCard(card, $fragment);
				});
			}
			self.$kanban_cards.append(fragment);
		}

		function setup_sortable() {

			// Block card dragging/record editing without 'write' access to reference doctype
			if (!frappe.model.can_write(store.state.doctype)) return;
			Sortable.create(self.$kanban_cards.get(0), {
				group: "cards",
				animation: 150,
				delay: 10,
				handle: '.kanban-handler',
				dataIdAttr: "data-name",
				forceFallback: true,
				onStart: function (e) {
					store.commit('set_dragging', true);
					wrapper.find(".kanban-card.add-card").fadeOut(200, function () {
						wrapper.find(".kanban-cards").height("100vh");
					});
					// Guardar la posición del scroll de la columna de origen antes de mover la tarjeta
					const fromColumn = $(e.from).parents(".kanban-column");
					scrollPos = window.screenX
				},
				onEnd: async function (e) {
					store.commit('set_dragging', false);
					wrapper.find(".kanban-card.add-card").fadeIn(100);
					wrapper.find(".kanban-cards").height("auto");

					// update order
					const args = {
						name: decodeURIComponent($(e.item).attr("data-name")),
						from_colname: $(e.from)
							.parents(".kanban-column")
							.attr("data-column-value"),
						to_colname: $(e.to).parents(".kanban-column").attr("data-column-value"),
						old_index: e.oldIndex,
						new_index: e.newIndex,
					};

					// Skip validation if from and to columns are the same
					if (args.from_colname === args.to_colname) {
						store.dispatch("update_order_for_single_card", args);
						return;
					}

					// Validate transitions based on destination column
					let validationPassed = true;

					// Mechanic validation - Check if user is a mechanic or junior mechanic
					const isMechanic = await erpnext.utils.isMechanic();
					const isJuniorMechanic = await erpnext.utils.isJuniorMechanic();

					if (isMechanic || isJuniorMechanic) {
						frappe.db.set_value("Project", args.name, "status", args.from_colname);
						showMessageNotAllowedUpdateStatus();
						validationPassed = false;
					}

					// Quality check approved validation
					if (validationPassed && args.to_colname === "Quality check approved") {
						await validate_project_quotations_and_requirements(args)
							.then(res => {
								console.log(`Validation passed for moving to Quality check approved: ${args.name}`);
							})
							.catch(error => {
								console.log(`Validation failed for Quality check approved: ${error || 'User cancelled'}`);
								validationPassed = false;
							});
					}

					// Completed validation
					if (validationPassed && args.to_colname === "Completed") {
						await validate_project_loan_car(args)
							.then(res => {
								console.log(`Validation passed for moving to Completed: ${args.name}`);
							})
							.catch(error => {
								console.log(`Validation failed for Completed: ${error || 'User cancelled'}`);
								validationPassed = false;
							});
					}

					// Queue notification confirmation for done statuses
					if (validationPassed && ["Completed", "Cancelled", "No response from customer"].includes(args.to_colname)) {
						await validate_queue_notification(args)
							.then(res => {
								console.log(`Queue notification confirmed for: ${args.name}`);
							})
							.catch(error => {
								console.log(`Queue notification cancelled: ${error || 'User cancelled'}`);
								validationPassed = false;
							});
					}

					// Remote diagnose to Completed special case
					if (validationPassed && args.from_colname === "In diagnosis" && args.to_colname === "After diagnosis") {
						showSentMessageAfterRemoteDiagnoseDialog(args.name);
					}

					if (validationPassed && args.to_colname === "In parking") {
						deactivateChatbot(args.name);
					}

					// Only update if all validations passed
					if (validationPassed) {
						store.dispatch("update_order_for_single_card", args);
					} else {
						console.log(`Card movement prevented due to failed validation: ${args.name}`);
						store.state.cur_list.refresh();
					}
				},
				onAdd: function () { },
				filter: '.kanban-title-area a'
			});
		}

		function bind_add_card() {
			var $wrapper = self.$kanban_column;
			var $btn_add = $wrapper.find(".add-card");
			var $new_card_area = $wrapper.find(".new-card-area");

			if (!frappe.model.can_create(store.state.doctype)) {
				// Block record/card creation without 'create' access to reference doctype
				$btn_add.remove();
				$new_card_area.remove();
				return;
			}

			var $textarea = $new_card_area.find("textarea");

			//Add card button
			$new_card_area.hide();
			$btn_add.on("click", function () {
				$btn_add.hide();
				$new_card_area.show();
				$textarea.focus();
			});

			//save on enter
			$new_card_area.keydown(function (e) {
				if (e.which == 13) {
					e.preventDefault();
					if (!frappe.request.ajax_count) {
						// not already working -- double entry
						e.preventDefault();
						var card_title = $textarea.val();
						$new_card_area.hide();
						$textarea.val("");
						store
							.dispatch("add_card", {
								card_title,
								column_title: column.title,
							})
							.then(() => {
								$btn_add.show();
							});
					}
				}
			});

			// on textarea blur
			$textarea.on("blur", function () {
				$(this).val("");
				$btn_add.show();
				$new_card_area.hide();
			});
		}

		function bind_options() {
			if (!board_perms.write) {
				// If no write access to board, column options should be hidden
				self.$kanban_column.find(".column-options").remove();
				return;
			}

			self.$kanban_column
				.find(".column-options .dropdown-menu")
				.on("click", "[data-action]", function () {
					var $btn = $(this);
					var action = $btn.data().action;

					if (action === "archive") {
						store.dispatch("archive_column", column);
					} else if (action === "indicator") {
						var color = $btn.data().indicator;
						store.dispatch("set_indicator", { column, color });
					}
				});

			get_column_indicators(function (indicators) {
				let html = `<li class="button-group">${indicators
					.map((indicator) => {
						let classname = frappe.scrub(indicator, "-");
						return `<div data-action="indicator" data-indicator="${indicator}" class="btn btn-default btn-xs indicator-pill ${classname}"></div>`;
					})
					.join("")}</li>`;
				self.$kanban_column.find(".column-options .dropdown-menu").append(html);
			});
		}

		init();
	};

	frappe.views.KanbanBoardCard = function (card, wrapper) {
		var self = {};

		function init() {
			if (!card) return;
			make_dom();
			render_card_meta();
			if (cur_list.board.show_preview_card) {
				bind_expand_button();
			}
		}

		function make_dom() {
			var opts = {
				name: card.name,
				title: frappe.utils.html2text(card.title),
				disable_click: card._disable_click ? "disable-click" : "",
				size_class: kanban_size,
				creation: card.creation,
				doc_content: get_doc_content(card),
				client_description: frappe.utils.html2text(card.doc.client_description),
				image_url: cur_list.get_image_url(card),
				form_link: frappe.utils.get_form_link(card.doctype, card.name),
				queue_position: 0,
				appointment_date: card.doc.appointment_date
					? card.doc.appointment_date.split('-').slice(1).reverse().join('-')
					: "",
				lane_icon: getLaneIcon(),
			};

			if ([ProjectStatusOptions.InQueue, ProjectStatusOptions.InParking].includes(card.column)) {
				opts.queue_position = card.doc.queue_position || "";
			}
			self.$card = $(frappe.render_template("kanban_card", opts)).appendTo(wrapper);
			apply_job_type_color();
			if (card.conversation) {
				self.$card.find(".kanban-card.content").addClass("conversation-border");
			}
			if (!frappe.model.can_write(card.doctype)) {
				// Undraggable card without 'write' access to reference doctype
				self.$card.find(".kanban-card-body").css("cursor", "default");
			}
		}

		function get_doc_content(card) {
			let fields = [];
			if (!cur_list.board.fields?.length) return;
			let render_fields = [...cur_list.board.fields];
			const icon_map = {
				'Project': 'rectangle_history_circle_user.svg',
				'ID': 'rectangle_history_circle_user.svg',
				'Queue position': 'map_pin_icon.svg',
				'Customer': 'user.svg',
				'Appointment date': 'calendar.svg',
				'Bring Car Date': 'car.svg',
				'Parking Date': 'car_building.svg',
				'Model': 'car.svg',
				'VIN': 'circle_info.svg',
				'Licence plate': 'address_card.svg',
				'Status': 'wrench.svg',
				'Created By': 'user.svg',
				'R.D Date': 'calendar.svg',
				'R.D Time': 'clock.svg',
				'Callback date': 'calendar.svg',
				'Calback time': 'clock.svg',
				'Type of job': 'ballot_check_sharp.svg',
				'Vehicle': 'car.svg',
				'Total Amount': 'circle_info.svg'
			};

			if (card.column === ProjectStatusOptions.RequestCallback) {
				render_fields.push(...['customer', 'callback_date', 'callback_time']);
			}

			if (card.column === ProjectStatusOptions.RemoteDiagnose) {
				render_fields.push(...['remote_diagnostic_date', 'remote_diagnostic_time']);
			}

			if (![ProjectStatusOptions.InQueue, ProjectStatusOptions.InParking].includes(card.column)) {
				render_fields = render_fields.filter(field => field !== "queue_position");
			}

			if (card.column === ProjectStatusOptions.InQueue) {
				render_fields = render_fields.filter(field => field !== "parking_date")
			}

			for (let field_name of render_fields) {
				let field =
					frappe.meta.docfield_map[card.doctype]?.[field_name] ||
					frappe.model.get_std_field(field_name);
				let icon = icon_map[field.label];
				let label = cur_list.board.show_labels && icon ? `<img title="${__(field.label)}" src="/assets/frappe/icons/jobcard/${icon}" style="height:0.75rem;">` : "";
				let value = frappe.format(field_name === "model" ? `${card.doc[field_name]} - ${card.doc.dsg_model}` : card.doc[field_name], field)
				let title = !/^<a/.test(value) ? value : ''
				fields.push(`
					<div class="text-muted text-truncate" style="display: flex; align-items: center; gap: 4px; margin-bottom: 1px; font-size: 10px;">
						${label}
						<span style="flex: 1; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;">${value}</span>
					</div>
				`);
			}
			if (card.border.message) {
				fields.push(`
					<div style="margin-top: 2px;">
						<span style="color: #d14343; font-style: italic; font-size: 9px; display: block; line-height: 1.1;"> ${card.border.message} </span>
					</div>
				`);
			}
			return fields.join("");
		}


		function get_tags_html(card) {
			return card.tags
				? `<div class="kanban-tags">
					${cur_list.get_tags_html(card.tags, 3, true)}
				</div>`
				: "";

		}

		function apply_job_type_color() {
			const job_type_colors = {
				"Diagnose": "#bfdbfe",   // Light Blue
				"Reparatie": "#fed7aa",  // Light Orange
				"Oliewissel": "#fef08a", // Light Yellow
				"Overig": "#ddd6fe",     // Light Purple
				"Software": "#a5f3fc",   // Light Cyan
				"Parts": "#a7f3d0",      // Light Green
			};
			const default_color = "#e5e7eb"; // Light Gray
			const job_type = card.doc?.type_of_job;
			const color = job_type_colors[job_type] || default_color;

			const $title_area = self.$card.find(".kanban-card .kanban-title-area");
			if ($title_area.length) {
				$title_area[0].style.setProperty("background-color", color, "important");
				$title_area.attr("title", job_type ? __("Type of job: {0}", [job_type]) : __("Type of job: Overig / Other"));
			}
		}

		function render_card_meta() {
			let html = `<div class="center_elements"> ${get_tags_html(card)}`;

			const $assignees_group = get_assignees_group();

			if (card.doctype === 'Project') {
				if (card.conversation) {
					html += '<img src="/assets/frappe/icons/jobcard/square-whatsapp.svg" style="height:1.2rem;margin-top:2px;" title="Whatsapp Conversation" />'
				}

				html += getPartsIcons()
				html += getSoftwareIcons()
				html += getLoanCarIcons()
				html += getPickupIcon()
				html += getQuotationIcon()
			}

			if (card.color && frappe.ui.color.validate_hex(card.color)) {
				const $div = $("<div>");
				$("<div></div>")
					.css({
						width: "30px",
						height: "4px",
						borderRadius: "2px",
						marginBottom: "8px",
						backgroundColor: card.color,
					})
					.appendTo($div);

				self.$card.find(".kanban-card .kanban-title-area").prepend($div);
			}
			html += '</div>'

			self.$card
				.find(".kanban-card-meta")
				.empty()
				.append(html);

			// if (kanban_size == KanbanSize.large) {
			self.$card
				.find(".kanban-assignments")
				.append($assignees_group);
			// }
		}

		function get_assignees_group() {
			return frappe.avatar_group(card.assigned_list, 3, {
				css_class: "avatar avatar-small",
				action_icon: "add",
				action: show_assign_to_dialog,
			});
		}

		/*
		colors used:
		#D14343  -- red
		#33AD53  -- green
		#D1D1D1  -- gray
		*/

		function getPartsIcons() {
			let html = "";
			let status = card.doc.parts_status || "Delivered";
			let title = `Parts: ${status}`;
			if (card.doc.parts_status === "New request") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="15.75" viewBox="0 0 576 512"><path class="fa-secondary" opacity=".4" fill="#d14343" d="M552 64H159.2l52.4 256h293.2a24 24 0 0 0 23.4-18.7l47.3-208a24 24 0 0 0 -18.1-28.7A23.7 23.7 0 0 0 552 64z"/><path class="fa-primary" fill="#d14343" d="M218.1 352h268.4a24 24 0 0 1 23.4 29.3l-5.5 24.3a56 56 0 1 1 -63.6 10.4H231.2a56 56 0 1 1 -67.1-8.6L93.9 64H24A24 24 0 0 1 0 40V24A24 24 0 0 1 24 0h102.5A24 24 0 0 1 150 19.2z"/></svg></span>`;
			}
			if (card.doc.parts_status === "Ready for pickup") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="15.75" viewBox="0 0 576 512"><path class="fa-secondary" opacity=".4" fill="#33ad53" d="M552 64H159.2l52.4 256h293.2a24 24 0 0 0 23.4-18.7l47.3-208a24 24 0 0 0 -18.1-28.7A23.7 23.7 0 0 0 552 64z"/><path class="fa-primary" fill="#33ad53" d="M218.1 352h268.4a24 24 0 0 1 23.4 29.3l-5.5 24.3a56 56 0 1 1 -63.6 10.4H231.2a56 56 0 1 1 -67.1-8.6L93.9 64H24A24 24 0 0 1 0 40V24A24 24 0 0 1 24 0h102.5A24 24 0 0 1 150 19.2z"/></svg></span>`;
			}
			if (card.doc.parts_status === "Delivered" || !card.doc.parts_status) {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="15.75" viewBox="0 0 576 512"><path fill="#d1d1d1" d="M528.1 301.3l47.3-208C578.8 78.3 567.4 64 552 64H159.2l-9.2-44.8C147.8 8 137.9 0 126.5 0H24C10.7 0 0 10.7 0 24v16c0 13.3 10.7 24 24 24h69.9l70.2 343.4C147.3 417.1 136 435.2 136 456c0 30.9 25.1 56 56 56s56-25.1 56-56c0-15.7-6.4-29.8-16.8-40h209.6C430.4 426.2 424 440.3 424 456c0 30.9 25.1 56 56 56s56-25.1 56-56c0-22.2-12.9-41.3-31.6-50.4l5.5-24.3c3.4-15-8-29.3-23.4-29.3H218.1l-6.5-32h293.1c11.2 0 20.9-7.8 23.4-18.7z"/></svg></span>`;
			}
			return html
		}

		function getQuotationIcon() {
			const QuotationStatus = {
				Declined: 'Quotation Declined',
				AwaitingApproval: 'Awaiting approval quotation',
				Approved: 'Quotation approved',
				AwaitingPayment: 'Invoice send awaiting payment',
				PaymentReady: 'Payment ready.'
			}
			const status = card.doc.payment_status
			const opts = {
				[QuotationStatus.Declined]: { class: 'blink-red', icon: 'fa-times-circle' },
				[QuotationStatus.AwaitingApproval]: { color: '#949418', icon: 'fa-file-o' },
				[QuotationStatus.Approved]: { color: 'green', icon: 'fa fa-file' },
				[QuotationStatus.AwaitingPayment]: { color: '#4287f5', icon: 'fa-file-text-o' },
				[QuotationStatus.PaymentReady]: { color: 'green', icon: 'fa-money' }
			}

			if (status === "No") return ''

			const config = opts[status] || { color: 'red', icon: 'fa-file' };
			return `<i class="fa ${config.icon} ${config.class ?? ''}" style="color:${config.color}" title="${status}"></i>`;
		}

		function getLaneIcon() {
			if (card.doc.lane === "FAST") {
				return '<i class="fa fa-tint" style="color: dark-brown; font-size: 1rem; margin-left: 4px; vertical-align: middle;" title="Fast Lane"></i>';
			}
			// Default or HEAVY
			return '<i class="fa fa-wrench" style="color: #d1d1d1; font-size: 1.1rem; margin-left: 4px; vertical-align: middle;" title="Heavy Lane"></i>';
		}

		function getSoftwareIcons() {
			let html = "";
			let status = card.doc.software_status || "No status";
			let title = `Software: ${status}`;
			if (card.doc.software_status === "Software request") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity="1" fill="#d14343" d="M24 190v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42V88H30a6 6 0 0 0 -6 6zm482 6h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0-96h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm-482-6v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6z"/><path class="fa-primary" fill="#d14343" d="M144 512a48 48 0 0 1 -48-48V48a48 48 0 0 1 48-48h224a48 48 0 0 1 48 48v416a48 48 0 0 1 -48 48z"/></svg></span>`;
			}
			if (card.doc.software_status === "Software is ready for use") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity="1" fill="#33ad53" d="M24 190v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42V88H30a6 6 0 0 0 -6 6zm482 6h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0-96h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm-482-6v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6z"/><path class="fa-primary" fill="#33ad53" d="M144 512a48 48 0 0 1 -48-48V48a48 48 0 0 1 48-48h224a48 48 0 0 1 48 48v416a48 48 0 0 1 -48 48z"/></svg></span>`;
			}
			if (card.doc.software_status === "Software has been attached" || !card.doc.software_status) {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity="1" fill="#d1d1d1" d="M24 190v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42V88H30a6 6 0 0 0 -6 6zm482 6h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0-96h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm-482-6v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6z"/><path class="fa-primary" fill="#d1d1d1" d="M144 512a48 48 0 0 1 -48-48V48a48 48 0 0 1 48-48h224a48 48 0 0 1 48 48v416a48 48 0 0 1 -48 48z"/></svg></span>`;
			}
			return html
		}

		function getLoanCarIcons() {
			let html = "";
			let status = card.doc.is_loan_car || "No";
			let title = `Loan Car: ${status}`;
			if (!card.doc.is_loan_car || card.doc.is_loan_car === "No" || card.doc.is_loan_car === "Car returned") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity="0.8" fill="#d1d1d1" d="M303.1 348.9l.1 .1-24 27a24 24 0 0 1 -17.9 8H224v40a24 24 0 0 1 -24 24h-40v40a24 24 0 0 1 -24 24H24a24 24 0 0 1 -24-24v-78a24 24 0 0 1 7-17l161.8-161.8-.1-.4a176.2 176.2 0 0 0 134.3 118.1z"/><path class="fa-primary" fill="#d1d1d1" d="M336 0a176 176 0 1 0 176 176A176 176 0 0 0 336 0zm48 176a48 48 0 1 1 48-48 48 48 0 0 1 -48 48z"/></svg></span>`;
			}
			else if (card.doc.is_loan_car === "Yes") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity=".4" fill="#d14343" d="M303.1 348.9l.1 .1-24 27a24 24 0 0 1 -17.9 8H224v40a24 24 0 0 1 -24 24h-40v40a24 24 0 0 1 -24 24H24a24 24 0 0 1 -24-24v-78a24 24 0 0 1 7-17l161.8-161.8-.1-.4a176.2 176.2 0 0 0 134.3 118.1z"/><path class="fa-primary" fill="#d14343" d="M336 0a176 176 0 1 0 176 176A176 176 0 0 0 336 0zm48 176a48 48 0 1 1 48-48 48 48 0 0 1 -48 48z"/></svg></span>`;
			} else if (card.doc.is_loan_car === "Loaned car") {
				html = `<span title="${title}"><svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity=".4" fill="#33ad53" d="M303.1 348.9l.1 .1-24 27a24 24 0 0 1 -17.9 8H224v40a24 24 0 0 1 -24 24h-40v40a24 24 0 0 1 -24 24H24a24 24 0 0 1 -24-24v-78a24 24 0 0 1 7-17l161.8-161.8-.1-.4a176.2 176.2 0 0 0 134.3 118.1z"/><path class="fa-primary" fill="#33ad53" d="M336 0a176 176 0 1 0 176 176A176 176 0 0 0 336 0zm48 176a48 48 0 1 1 48-48 48 48 0 0 1 -48 48z"/></svg></span>`;
			}
			return html
		}

		function getPickupIcon() {
			const pickupStatus = {
				dropoff: 'Dropoff service',
				pickup: 'Pickup service',
				dropoffArranged: 'Dropoff service arranged',
				pickupArranged: 'Pickup service arranged',
			}
			const status = card.doc.pickup
			const opts = {
				[pickupStatus.dropoff]: { class: 'blink-red' },
				[pickupStatus.dropoffArranged]: { color: 'green' },
				[pickupStatus.pickup]: { class: 'blink-red' },
				[pickupStatus.pickupArranged]: { color: 'green' }
			}

			return `<i class="fa fa-taxi  ${opts[status]?.class ?? ''}" style="color:${opts[status]?.color ?? '#d1d1d1'};" title="${status || 'Pickup Status: None'}"></i>`;
		}

		function bind_expand_button() {
			self.$card = $(wrapper).find('.kanban-card-wrapper[data-name="' + encodeURIComponent(card.name) + '"]');
			const $detailButton = self.$card.find('.kanban-card-detail-button');
			const $touchButton = self.$card.find('.kanban-card-touch-button button');
			const $detailsPanel = $(document).find('.kanban-card-details');


			// Check if device is touch-enabled
			const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

			// Show/hide touch button based on device type
			if (isTouchDevice) {
				$touchButton.parent().show();
			} else {
				$touchButton.parent().hide();
			}

			// Handle click on detail button (for desktop)
			$detailButton.on('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				toggle_card_details();
			});

			// Handle click on touch button (for mobile/touch devices)
			$touchButton.on('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				toggle_card_details();
			});

			// For non-touch devices, support hover
			if (!isTouchDevice) {
				self.$card.on('mouseenter', function (e) {
					if (store.state.is_dragging) return;
					clearTimeout(mouseLeaveTimeout)
					expand_card_details();
				});

				self.$card.on('mouseleave', function () {
					if (store.state.is_dragging) return;
					mouseLeaveTimeout = setTimeout(() => {
						collapse_card_details();
					}, 150);
				});

				self.$card.on("mousedown", function () {
					if (store.state.is_dragging) return;
					clearTimeout(mouseLeaveTimeout)
					collapse_card_details()
				})

				$detailsPanel.on('mouseenter', function (e) {
					clearTimeout(mouseLeaveTimeout)
				})

				$detailsPanel.on('mouseleave', function () {
					collapse_card_details();
				});
			}

			function toggle_card_details() {
				if ($detailsPanel.hasClass('expanded')) {
					collapse_card_details();
				} else {
					expand_card_details();
				}
			}

			function expand_card_details() {
				const $detailsBody = $(document).find('.kanban-card-details-body');
				const $detailsTitle = $(document).find('.kanban-card-details-title');
				const $detailsLink = $(document).find('.kanban-card-details-link')
				const $kanban = self.$card.closest('.kanban')[0] || document.querySelector('.kanban');

				$detailsBody.html(get_card_detail_html());
				$detailsTitle.html(card.name)
				$detailsLink.attr('href', `/app/project/${card.name}`)

				const cardRect = self.$card[0].getBoundingClientRect();
				const kanban = $kanban.getBoundingClientRect()
				const panelHeight = $detailsPanel.outerHeight() || 500;
				const panelWidth = $detailsPanel.outerWidth() || 500;
				const viewportHeight = window.innerHeight;
				const viewportWidth = window.innerWidth;

				if (cardRect.right + panelWidth + 5 > viewportWidth) {
					$detailsPanel.css('left', (cardRect.left - panelWidth) + 'px');
				} else {
					$detailsPanel.css('left', (cardRect.right - kanban.left + 2) + 'px');
				}

				if (cardRect.top + panelHeight > viewportHeight) {
					$detailsPanel.css('top', cardRect.bottom - panelHeight - kanban.top + 'px');
				} else {
					$detailsPanel.css('top', cardRect.top - kanban.top + 'px');
				}


				$detailsPanel.addClass('expanded');
				self.$card.addClass('with-details');
			}

			function collapse_card_details() {
				const $detailsPanel = $(document).find('.kanban-card-details');
				$detailsPanel.removeClass('expanded');
				self.$card.removeClass('with-details');
			}

			function get_card_detail_html() {
				let html = '';

				// Add card fields to details panel
				// Use card_fields if available, otherwise fall back to regular fields
				let fields = cur_list.board.card_fields || cur_list.board.fields || [];

				fields.forEach(field_name => {
					const field = frappe.meta.docfield_map[card.doctype]?.[field_name] ||
						frappe.model.get_std_field(field_name);

					if (!field) return;

					if (field.fieldtype === "Text Editor" || field.fieldtype === "HTML Editor") {

						function renderHtmlContent(content) {
							const div = document.createElement('div');
							div.innerHTML = content;
							return div.innerHTML;
						}

						html += `
								<div class="kanban-card-detail-item item-full">
										<div class="kanban-card-detail-label">${__(field.label)}</div>
										<div class="kanban-card-detail-value">${renderHtmlContent(card.doc[field_name])}</div>
								</div>
						`;

						return html
					}

					const value = frappe.format(card.doc[field_name], field);

					html += `
						<div class="kanban-card-detail-item">
							<div class="kanban-card-detail-label">${__(field.label || field_name)}</div>
							<div class="kanban-card-detail-value">${value || 'No value'}</div>
						</div>
					`;
				});

				// Add description if available
				if (card.doc.description) {
					html += `
						<div class="kanban-card-detail-item">
							<div class="kanban-card-detail-label">${__('Description')}</div>
							<div class="kanban-card-detail-value">${card.doc.description}</div>
						</div>
					`;
				}

				return html;
			}
		}

		function show_assign_to_dialog(e) {
			e.preventDefault();
			e.stopPropagation();
			self.assign_to = new frappe.ui.form.AssignToDialog({
				obj: self,
				method: "frappe.desk.form.assign_to.add",
				doctype: card.doctype,
				docname: card.name,
				callback: function () {
					const users = self.assign_to_dialog.get_values().assign_to;
					card.assigned_list = [...new Set(card.assigned_list.concat(users))];
					store.dispatch("update_card", card);
				},
			});
			self.assign_to_dialog = self.assign_to.dialog;
			self.assign_to_dialog.show();
		}

		init();
	};

	function prepare_card(card, state, doc, customer_responded) {
		var assigned_list = card._assign ? JSON.parse(card._assign) : [];
		var comment_count = card._comment_count || 0;

		if (doc) {
			card = Object.assign({}, card, doc);
		}

		return {
			doctype: state.doctype,
			name: card.name,
			title: card[state.card_meta.title_field.fieldname],
			creation: moment(card.creation).format("MMM DD, YYYY"),
			_liked_by: card._liked_by,
			image: card[cur_list.meta.image_field],
			tags: card._user_tags,
			column: card[state.board.field_name],
			assigned_list: card.assigned_list || assigned_list,
			comment_count: card.comment_count || comment_count,
			color: card.color || null,
			doc: doc || card,
			border: set_border_color(card, customer_responded),
			conversation: hasconversationUnread(card),
			status_modified: card.status_modified,
		};
	}

	function hasconversationUnread(card) {
		return unread_conversations.find((el) => el.from === card.custom_customers_phone_number)
	}

	function set_border_color(card, customer_responded) {
		let message = false;
		const nowDate = new Date();
		const modifiedDate = new Date(card.status_modified);
		const dayDifference = satuday_sunday_combined(modifiedDate, nowDate);
		const in_parking = card.status === 'In parking' && Number(card.queue_position) <= 5 && satuday_sunday_combined(card.parking_date, nowDate) >= 2;;
		const quotation = card.status === 'Quoted' && quotations_draft.length && quotations_draft.find(quotation => quotation.parent == card.name);
		const hass_passed_one_day_quotation = quotation && has_passed_one_day(quotation.modified);

		if (in_parking) {
			message = "2 days since moved to parking.";
		} else if (hass_passed_one_day_quotation) {
			message = "The quote was sent over a day ago.";
		} else if (card.status_modified &&
			card.status !== 'In queue' &&
			card.status !== 'In parking' &&
			card.status !== 'Completed' &&
			!isNaN(modifiedDate.getTime()) &&
			dayDifference > 2 && !customer_responded) {
			message = same_status_2days;
		}
		return { message };
	}

	const _satSunCache = new Map();
	function satuday_sunday_combined(startDate, endDate) {
		const key = String(startDate) + "|" + (endDate instanceof Date ? endDate.toDateString() : String(endDate));
		if (_satSunCache.has(key)) return _satSunCache.get(key);
		const isWeekend = date => date.getDay() % 6 === 0;
		const isWeekday = date => date.getDay() >= 1 && date.getDay() <= 5;
		let dayDifference = 0;
		let currentDate = new Date(startDate);
		let hasWeekend = false;
		while (currentDate <= endDate) {
			if (isWeekday(currentDate)) {
				dayDifference++;
			} else if (isWeekend(currentDate)) {
				if (!hasWeekend) {
					dayDifference++;
					hasWeekend = true;
				}
			}
			currentDate.setDate(currentDate.getDate() + 1);
		}
		if (hasWeekend) {
			dayDifference--;
		}
		_satSunCache.set(key, dayDifference);
		return dayDifference;
	}

	function has_passed_one_day(modifiedString) {
		if (!modifiedString) return false
		const modifiedDate = new Date(modifiedString);
		const currentDate = new Date();
		const differenceInMs = currentDate - modifiedDate;
		const millisecondsInADay = 24 * 60 * 60 * 1000;
		const differenceInDays = differenceInMs / millisecondsInADay;
		return differenceInDays >= 1;
	}

	async function last_message_from_customer(phone_numbers) {
		if (_convCacheValid() && _convCache.lastMessage) {
			return _convCache.lastMessage;
		}
		const conversations = await frappe.db.get_list('Conversation', {
			filters: {
				from: ["in", [...phone_numbers]],
				last_message_from_customer: 1
			},
			fields: ["from"],
		});
		const result = conversations.map(conversation => conversation.from);
		_convCache.lastMessage = result;
		_convCache.ts = Date.now();
		return result;
	}

	async function getUnreadConversations() {
		if (_convCacheValid() && _convCache.unread) {
			unread_conversations = _convCache.unread;
			return;
		}
		unread_conversations = await frappe.db.get_list('Conversation', {
			filters: { seen: 0 },
			fields: ["name", "from"],
			ip: 1
		});
		_convCache.unread = unread_conversations;
		_convCache.ts = Date.now();
	}

	function prepare_columns(columns) {
		let cols = [];
		const seen = new Set();
		// const isAdmin = frappe.user.has_role("Administrator");
		// const isMechanic = !isAdmin && frappe.user.has_role("Mechanic");
		columns.forEach(function (col) {
			// if (isMechanic && !columnsByMechanic[col.column_name]) {
			// 	return; // Skip columns not in columnsByMechanic
			// }
			if (seen.has(col.column_name)) return;
			seen.add(col.column_name);
			col = {
				title: col.column_name,
				status: col.status,
				order: col.order,
				indicator: col.indicator || "gray",
			};
			cols.push(col);
		});
		return cols;
	}

	function modify_column_field_in_c11n(doc, board, title, action) {
		doc.fields.forEach(function (df) {
			if (df.fieldname === board.field_name && df.fieldtype === "Select") {
				if (!df.options) df.options = "";

				if (action === "add") {
					//add column_name to Select field's option field
					if (!df.options.includes(title)) df.options += "\n" + title;
				} else if (action === "delete") {
					var options = df.options.split("\n");
					var index = options.indexOf(title);
					if (index !== -1) options.splice(index, 1);
					df.options = options.join("\n");
				}
			}
		});
		return doc;
	}

	function fetch_customization(doctype) {
		return new Promise(function (resolve) {
			frappe.model.with_doc("Customize Form", "Customize Form", function () {
				var doc = frappe.get_doc("Customize Form");
				doc.doc_type = doctype;
				frappe.call({
					doc: doc,
					method: "fetch_to_customize",
					callback: function (r) {
						resolve(r.docs[0]);
					},
				});
			});
		});
	}

	function save_customization(doc) {
		if (!doc) return;
		doc.hide_success = true;
		return frappe.call({
			doc: doc,
			method: "save_customization",
		});
	}

	function insert_doc(doc) {
		return frappe.call({
			method: "frappe.client.insert",
			args: {
				doc: doc,
			},
			callback: function () {
				frappe.model.clear_doc(doc.doctype, doc.name);
				frappe.show_alert({ message: __("Saved"), indicator: "green" }, 1);
			},
		});
	}

	function update_kanban_board(board_name, column_title, action) {
		var method;
		var args = {
			board_name: board_name,
			column_title: column_title,
		};
		if (action === "add") {
			method = "add_column";
		} else if (action === "archive" || action === "restore") {
			method = "archive_restore_column";
			args.status = action === "archive" ? "Archived" : "Active";
		}
		return frappe.call({
			method: method_prefix + method,
			args: args,
		});
	}

	function is_active_column(col) {
		return col.status !== "Archived";
	}

	function get_cards_for_column(cards, column) {
		return cards.filter(function (card) {
			return card.column === column.title;
		});
	}

	function get_card(name) {
		return store.state.cards.find(function (c) {
			return c.name === name;
		});
	}

	function update_cards_column(updated_cards) {
		var cards = store.state.cards;
		cards.forEach(function (c) {
			updated_cards.forEach(function (uc) {
				if (uc.name === c.name) {
					c.column = uc.column;
				}
			});
		});
		return cards;
	}

	function get_column_indicators(callback) {
		frappe.model.with_doctype("Kanban Board Column", function () {
			var meta = frappe.get_meta("Kanban Board Column");
			var indicators;
			meta.fields.forEach(function (df) {
				if (df.fieldname === "indicator") {
					indicators = df.options.split("\n");
				}
			});
			if (!indicators) {
				//
				indicators = ["green", "blue", "orange", "gray"];
			}
			callback(indicators);
		});
	}

	async function get_kanban_size_by_user(store) {
		const user = frappe.session.user;
		const settings = await frappe
			.call("frappe.desk.form.load.getdoc", { doctype: "User", name: user })
			.then((r) => {
				return r.docs && r.docs.length ? r.docs[0] : { size_kanban: KanbanSize.large }
			});
		const value = settings.size_kanban ?? KanbanSize.large
		store.dispatch("update_kanban_size_range", value)

		const zoomSlider = document.getElementById('zoom-slider');
		const initialZoomLevel = Object.keys(zoomLevels).find(key => zoomLevels[key] === value);
		zoomSlider.value = initialZoomLevel;

		return value
	}

	function setup_zoom_component() {
		const zoomSlider = document.getElementById('zoom-slider');
		const zoomIn = document.getElementById('zoom-icon-in');
		const zoomOut = document.getElementById('zoom-icon-out');

		setTimeout(() => { }, 1000)
		zoomIn.addEventListener('click', () => {
			if (zoomSlider.value < 3) {
				zoomSlider.value = parseInt(zoomSlider.value) + 1;
				applyZoom(zoomSlider.value);
			}
		});

		zoomOut.addEventListener('click', () => {
			if (zoomSlider.value > 1) {
				zoomSlider.value = parseInt(zoomSlider.value) - 1;
				applyZoom(zoomSlider.value);
			}
		});

		zoomSlider.addEventListener('input', () => {
			applyZoom(zoomSlider.value);
		});

		// Inicializa el estado correcto de las tarjetas
		document.querySelectorAll('.kanban-card-wrapper').forEach(el => {
			const sizeClass = Array.from(el.classList).find(cls => ['small', 'medium', 'large'].includes(cls));

			const metaElement = el.querySelector('.kanban-card-meta');
			if (metaElement) {
				if (sizeClass === 'small') {
					metaElement.style.display = 'none';
				} else {
					metaElement.style.display = 'block';
				}
			}
		});
	}

	function removeAllSizeClasses() {
		// Remover las clases 'small', 'medium' y 'large' de las columnas
		document.querySelectorAll('.kanban-column').forEach(el => {
			el.classList.remove('small', 'medium', 'large');
		});

		// Remover las clases 'small', 'medium' y 'large' de las tarjetas
		document.querySelectorAll('.kanban-card-wrapper').forEach(el => {
			el.classList.remove('small', 'medium', 'large');
		});
	}

	function applyNewSizeClass(sizeClass) {
		// Aplicar la nueva clase a las columnas
		document.querySelectorAll('.kanban-column').forEach(el => {
			el.classList.add(sizeClass);
		});

		// Aplicar la nueva clase a las tarjetas
		document.querySelectorAll('.kanban-card-wrapper').forEach(el => {
			el.classList.add(sizeClass);

			// Mostrar u ocultar el elemento kanban-card-meta
			const metaElement = el.querySelector('.kanban-card-meta');
			if (metaElement) {
				if (sizeClass === 'small') {
					metaElement.style.display = 'none';  // Ocultar
				} else {
					metaElement.style.display = 'block'; // Mostrar
				}
			}
		});
	}

	function applyZoom(value) {
		let zoomState = zoomLevels[value];
		store.dispatch("update_kanban_size_range", zoomState);

		// Remover todas las clases de tamaño antes de aplicar la nueva clase
		removeAllSizeClasses();
		applyNewSizeClass(zoomState);

		// Actualizar la configuración en el backend sin recargar la página
		frappe.call({
			method: "frappe.core.doctype.user.user.update_kanban_size",
			args: {
				value: zoomState,
			},
			callback: function (r) {
				console.log("Kanban size updated in the backend");
			},
		});

		return zoomState;
	}

	function validate_project_quotations_and_requirements(args) {
		return new Promise(async (resolve, reject) => {
			const project = await frappe.db.get_doc('Project', args.name)
			const incomplete_requirements = project.requirements.filter(requirement => !requirement.completed)
			const quotations = await frappe.db.get_list("Quotation", {
				filters: [
					['project_name', '=', args.name],
					['status', "!=", "Approved"],
					['status', "!=", "Ordered"],
					['status', "!=", "Cancelled"],
					['status', "!=", "Paid"],
				],
				fields: ["name", "status"]
			})

			if (!quotations?.length && !incomplete_requirements.length) {
				resolve()
				return
			}

			showConfirmationDialog(args, quotations, incomplete_requirements, resolve, reject)
		})
	}

	function validate_project_loan_car(args) {
		return new Promise(async (resolve, reject) => {
			const loan_car = await frappe.db.get_list('Loan car', { fields: ["name", "status"], filters: [["project", "=", args.name], ["status", "!=", "Paid"], ["status", "!=", "Done"], ["status", "!=", "Cancelled"]] })

			if (!loan_car.length) {
				resolve()
				return
			}

			frappe.db.set_value("Project", args.name, "status", args.from_colname)

			showLoanCarNotPaidAlert(loan_car[0], reject)
		})
	}

	function validate_queue_notification(args) {
		return new Promise((resolve, reject) => {
			showQueueNotificationConfirmDialog(args, resolve, reject);
		});
	}

	function showQueueNotificationConfirmDialog(args, resolve, reject) {
		const dialog = new frappe.ui.Dialog({
			title: 'Confirm',
			fields: [
				{
					fieldtype: 'HTML',
					options: `<p>Moving this project to <strong>${args.to_colname}</strong> will update queue positions and customers in the queue will be notified. Are you sure you want to proceed?</p>`
				}
			],
			primary_action_label: 'Confirm',
			primary_action: function () {
				dialog.hide();
				resolve();
			},
			secondary_action_label: 'Cancel',
			secondary_action: function () {
				frappe.db.set_value("Project", args.name, "status", args.from_colname);
				reject();
				dialog.hide();
			}
		});

		dialog.$wrapper.find('.modal-header .modal-actions').hide();
		dialog.$wrapper.modal({ backdrop: 'static', keyboard: false });

		dialog.show();
	}

	function showConfirmationDialog(args, quotations, incomplete_requirements, resolve, reject) {
		const dialog = new frappe.ui.Dialog({
			title: 'Confirm',
			fields: buildFields(args, quotations, incomplete_requirements),
			primary_action_label: 'Confirm',
			primary_action: function () {
				dialog.hide();
				resolve()
			},
			secondary_action_label: 'Cancel',
			secondary_action: function () {
				frappe.db.set_value("Project", args.name, "status", args.from_colname)
				reject()
				dialog.hide();
			}
		});

		dialog.$wrapper.find('.modal-header .modal-actions').hide();
		dialog.$wrapper.modal({ backdrop: 'static', keyboard: false })

		dialog.show();
	}

	function buildFields(args, quotations, incomplete_requirements) {
		const quotation_fields = [
			{
				fieldtype: 'HTML',
				options: `<h3>Pending Quotations</h3> `
			},
			{
				fieldtype: 'HTML',
				options: `<p>Project <strong>${args.name}</strong> has the following quotation pending approval:</p> `
			},
			{
				fieldtype: 'HTML',
				options: `
					<ul style="border-bottom: 1px solid black;padding-bottom:1rem;">
					${quotations.map(quotation => `<li><strong>Quotation:</strong> <a href="/app/quotation/${quotation.name}" target="__blank">${quotation.name}</a>, <strong>Status:</strong> ${quotation.status}.</li>\n`)}
					</ul>
				`
			}
		]
		const requirements_fields = [
			{
				fieldtype: 'HTML',
				options: `<h3>Incomplete Client Requirements</h3> `
			},
			{
				fieldtype: 'HTML',
				options: `
					<ul>
					${incomplete_requirements.map(item => `<li><strong>Requirement:</strong> ${item.requirement}</li>\n`)}
					</ul>
				`
			},
		]
		const question_field = {
			fieldtype: 'HTML',
			options: `
				<p>Are you sure you want to proceed? ${quotations.length ? "The quotations listed will not be included in the invoice" : ""}</p>
			`
		}

		let fields = []

		if (quotations.length) {
			fields.push(...quotation_fields)
		}

		if (incomplete_requirements.length) {
			fields.push(...requirements_fields)
		}

		fields.push(question_field)

		return fields
	}

	function showSentMessageAfterRemoteDiagnoseDialog(project_name) {
		const dialog = new frappe.ui.Dialog({
			title: 'Remote Diagnose Completed',
			fields: [
				{
					fieldtype: 'HTML',
					options: `<p>Would you like to send the customer an invitation to schedule an appointment with our workshop?</p> `
				},
			],
			primary_action_label: 'Yes',
			primary_action: async function () {
				const { aws_url } = await frappe.db.get_doc("Whatsapp Config")
				await frappe.call({
					method: 'frappe.desk.doctype.kanban_board.kanban_board.call_send_whatsapp_message',
					args: { aws_url: aws_url, project_name: project_name }
				})
				dialog.hide();
			},
			secondary_action_label: 'No',
			secondary_action: function () {
				dialog.hide();
			}
		});

		dialog.show();
	}

	function showLoanCarNotPaidAlert(loan_car, reject) {
		const dialog = new frappe.ui.Dialog({
			title: 'Loan Car Alert',
			fields: [
				{
					fieldtype: 'HTML',
					options: `<p>Loan car: <a href="/app/loan-car/${loan_car.name}" target="__blank">${loan_car.name}</a> is is status: ${loan_car.status}</p> `
				},
			],
			primary_action_label: 'Ok',
			primary_action: function () {
				reject()
				dialog.hide();
			},
		});

		dialog.$wrapper.find('.modal-header .modal-actions').hide();
		dialog.$wrapper.modal({ backdrop: 'static', keyboard: false })

		dialog.show();
	}

	function showMessageNotAllowedUpdateStatus() {
		frappe.msgprint({
			title: "Not Allowed",
			message: "You are not allowed to update the status of this project.",
			indicator: "red",
			alert: true
		});
	}

	async function deactivateChatbot(project_name) {
		const project = await frappe.db.get_doc('Project', project_name)
		const conversations = await frappe.db.get_list('Conversation', { filters: { from: project.custom_customers_phone_number } })
		for (const conversation of conversations) {
			await frappe.db.set_value('Conversation', conversation.name, { 'is_auto_reply': 0, 'seen': 0 })
		}
	}
})();
