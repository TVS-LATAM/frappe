/*
Icon theme for the Project kanban board.

Single source of truth for every icon painted on a Project card. Both the card
renderer (`frappe.views.KanbanBoardCard`, in kanban_board.bundle.js) and the icon
legend modal render from the maps below through the same `render_*_icon()`
functions, so the legend can never drift from what the cards actually show.
Never inline an icon's markup or colour at a call site — add it here instead.

This module is imported by kanban_board.bundle.js and nowhere else. Keep it a
plain sibling module (NOT a *.bundle.js file) so esbuild bundles it into the
board entry point instead of treating it as its own entry.

Palette — deliberately LIGHT/pale so the icons read soft on the card. The reds
stay a touch more saturated than the rest because they carry the "needs
attention" signal (Declined / Lost / blink). To go lighter or darker, edit ONLY
the values in `IconColor` (plus the two lane colours below).

colors used:
#f2a6a6  -- red   (light)
#a3d9a5  -- green (light)
#e0e0e0  -- gray  (light)
#d4d488  -- olive (light)
*/
const IconColor = {
	red: "#f2a6a6",
	green: "#a3d9a5",
	gray: "#e0e0e0",
	olive: "#d4d488",
};

// --- Instant hover tooltips ---------------------------------------------
// The browser's native `title` tooltip has a ~1s delay and often fails to
// appear at all — a mechanic hovering an icon could not find out what it meant
// (this happened on the shop floor). That delay is browser-controlled and
// cannot be shortened from HTML/CSS, so we render our own tooltip instead: it
// appears instantly, is never clipped by the scrolling columns (it is
// fixed-positioned on <body>), and shows the full description, not just a short
// label. Icons carry their text in data-* attributes; ONE delegated listener
// drives a single shared tooltip element for the whole page, so it keeps
// working across card re-renders and on every board without re-binding.

function escape_html(text) {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Attributes every icon gets so the shared tooltip can describe it. `aria-label`
// keeps it accessible to screen readers. We deliberately DO NOT emit a native
// `title` — it would show a second, delayed tooltip on top of ours.
function tip_attrs(title, description) {
	const label = description ? `${title} — ${description}` : title;
	return `data-kanban-tip="1" data-kanban-tip-title="${escape_html(title)}" ` +
		`data-kanban-tip-desc="${escape_html(description || "")}" aria-label="${escape_html(label)}"`;
}

let _tooltip_el = null;
let _tooltips_installed = false;

function get_tooltip_el() {
	if (_tooltip_el) return _tooltip_el;
	_tooltip_el = document.createElement("div");
	_tooltip_el.className = "kanban-icon-tooltip";
	// Inline styles so this needs no separate CSS build. High z-index to clear
	// dialogs/overlays; pointer-events none so it never steals the hover.
	Object.assign(_tooltip_el.style, {
		position: "fixed",
		zIndex: "2000",
		maxWidth: "280px",
		padding: "7px 10px",
		borderRadius: "6px",
		background: "#1f272e",
		color: "#fff",
		fontSize: "12.5px",
		lineHeight: "1.4",
		boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
		pointerEvents: "none",
		opacity: "0",
		transition: "opacity 80ms ease",
		display: "none",
	});
	document.body.appendChild(_tooltip_el);
	return _tooltip_el;
}

function show_icon_tooltip(target) {
	const title = target.getAttribute("data-kanban-tip-title") || "";
	const desc = target.getAttribute("data-kanban-tip-desc") || "";
	const el = get_tooltip_el();
	el.innerHTML = `<div style="font-weight:600;">${escape_html(title)}</div>` +
		(desc ? `<div style="opacity:0.85;margin-top:2px;">${escape_html(desc)}</div>` : "");
	el.style.display = "block";
	el.style.opacity = "0";
	// Center above the icon; flip below if there is no room, clamp to viewport.
	const rect = target.getBoundingClientRect();
	const tip = el.getBoundingClientRect();
	let left = rect.left + rect.width / 2 - tip.width / 2;
	let top = rect.top - tip.height - 8;
	if (top < 4) top = rect.bottom + 8;
	left = Math.max(4, Math.min(left, window.innerWidth - tip.width - 4));
	el.style.left = `${left}px`;
	el.style.top = `${top}px`;
	el.style.opacity = "1";
}

function hide_icon_tooltip() {
	if (!_tooltip_el) return;
	_tooltip_el.style.opacity = "0";
	_tooltip_el.style.display = "none";
}

// Install once, globally. Delegated on the document so it survives card
// re-renders and covers every board.
export function setup_icon_tooltips() {
	if (_tooltips_installed) return;
	_tooltips_installed = true;
	document.addEventListener("mouseover", (e) => {
		const target = e.target.closest?.("[data-kanban-tip]");
		if (target) show_icon_tooltip(target);
	});
	document.addEventListener("mouseout", (e) => {
		if (e.target.closest?.("[data-kanban-tip]")) hide_icon_tooltip();
	});
	// Hide while the columns scroll so it never lingers in the wrong spot.
	document.addEventListener("scroll", hide_icon_tooltip, true);
}

// --- Quotation ----------------------------------------------------------
// The quotation icon is derived ONLY from the real linked Quotation
// (`Quotation.project_name` -> `Project.name`). The manual `Project.payment_status`
// select is NOT a source here: nothing syncs it with the Quotation doctype, so it
// used to make the icon claim a quotation was approved while it was still open.
const QuotationStatus = {
	Draft: "Draft",
	Open: "Open",
	Replied: "Replied",
	Approved: "Approved",
	PartiallyOrdered: "Partially Ordered",
	Ordered: "Ordered",
	PartiallyPaid: "Partially Paid",
	Paid: "Paid",
	Declined: "Declined",
	Lost: "Lost",
	Expired: "Expired",
	Cancelled: "Cancelled",
};

// Sentinel for "this project has no quotation at all".
export const NO_QUOTATION = "None";

// Most advanced status first. Used to pick one quotation when a project has several.
export const QUOTATION_STATUS_PRECEDENCE = [
	QuotationStatus.Paid,
	QuotationStatus.PartiallyPaid,
	QuotationStatus.Ordered,
	QuotationStatus.PartiallyOrdered,
	QuotationStatus.Approved,
	QuotationStatus.Replied,
	QuotationStatus.Open,
	QuotationStatus.Draft,
	QuotationStatus.Declined,
	QuotationStatus.Lost,
	QuotationStatus.Expired,
	QuotationStatus.Cancelled,
];

// Every Quotation lifecycle status gets its OWN light colour. With only the 4
// shared IconColor values, many statuses collapsed into look-alikes (Draft==Open,
// Approved==Partially Ordered==Ordered, Declined==Lost, Expired==Cancelled), so the
// icon could not tell them apart. Hues follow the lifecycle: neutral -> blue (sent)
// -> yellow (replied) -> greens (approved/ordered) -> rich green (paid) ->
// red/orange (declined/lost) -> muted (expired/cancelled). All stay light; the most
// advanced states (Ordered, Paid) are a touch deeper so they read as "further along".
const QuotationColor = {
	none: "#d9d9d9",             // No quotation — neutral gray
	draft: "#c2c9d4",            // Draft — cool slate (barely started)
	open: "#9fc3ea",             // Open — sky blue (sent, waiting)
	replied: "#f0d873",          // Replied — yellow (needs a decision)
	approved: "#aaddaa",         // Approved — light green
	partiallyOrdered: "#83d1bb", // Partially Ordered — teal
	ordered: "#5fc59b",          // Ordered — deeper teal-green
	partiallyPaid: "#cfe088",    // Partially Paid — lime
	paid: "#3fb469",             // Paid — rich green (money secured)
	declined: "#f0a0a0",         // Declined — light red (attention)
	lost: "#f3b485",             // Lost — light orange (attention, distinct from declined)
	expired: "#c9b7d6",          // Expired — lavender (stale)
	cancelled: "#cdbfae",        // Cancelled — taupe (dead)
};

const QUOTATION_ICONS = {
	[NO_QUOTATION]: {
		icon: "fa-file",
		color: QuotationColor.none,
		title: "No quotation",
		description: "No quotation has been created for this project yet.",
	},
	[QuotationStatus.Draft]: {
		icon: "fa-file-o",
		color: QuotationColor.draft,
		title: "Quotation: Draft",
		description: "A quotation exists but has not been submitted to the customer.",
	},
	[QuotationStatus.Open]: {
		icon: "fa-file-o",
		color: QuotationColor.open,
		title: "Quotation: Open",
		description: "The quotation was sent and is waiting for the customer's answer.",
	},
	[QuotationStatus.Replied]: {
		icon: "fa-file-o",
		color: QuotationColor.replied,
		title: "Quotation: Replied",
		description: "The customer replied to the quotation; it still needs a decision.",
	},
	[QuotationStatus.Approved]: {
		icon: "fa-file",
		color: QuotationColor.approved,
		title: "Quotation: Approved",
		description: "The customer approved the quotation.",
	},
	[QuotationStatus.PartiallyOrdered]: {
		icon: "fa-file",
		color: QuotationColor.partiallyOrdered,
		title: "Quotation: Partially Ordered",
		description: "Part of the approved quotation has been turned into a sales order.",
	},
	[QuotationStatus.Ordered]: {
		icon: "fa-file",
		color: QuotationColor.ordered,
		title: "Quotation: Ordered",
		description: "The whole quotation has been turned into a sales order.",
	},
	[QuotationStatus.PartiallyPaid]: {
		icon: "fa-money",
		color: QuotationColor.partiallyPaid,
		title: "Quotation: Partially Paid",
		description: "The customer has paid part of the quotation.",
	},
	[QuotationStatus.Paid]: {
		icon: "fa-money",
		color: QuotationColor.paid,
		title: "Quotation: Paid",
		description: "The quotation has been paid in full.",
	},
	[QuotationStatus.Declined]: {
		icon: "fa-times-circle",
		color: QuotationColor.declined,
		class: "blink-red",
		title: "Quotation: Declined",
		description: "The customer declined the quotation. Needs attention.",
	},
	[QuotationStatus.Lost]: {
		icon: "fa-times-circle",
		color: QuotationColor.lost,
		class: "blink-red",
		title: "Quotation: Lost",
		description: "The quotation was marked as lost. Needs attention.",
	},
	[QuotationStatus.Expired]: {
		icon: "fa-times-circle",
		color: QuotationColor.expired,
		title: "Quotation: Expired",
		description: "The quotation is no longer valid.",
	},
	[QuotationStatus.Cancelled]: {
		icon: "fa-times-circle",
		color: QuotationColor.cancelled,
		title: "Quotation: Cancelled",
		description: "The quotation was cancelled.",
	},
};

export function render_quotation_icon(status) {
	const config = QUOTATION_ICONS[status] || QUOTATION_ICONS[NO_QUOTATION];
	return `<i class="fa ${config.icon} ${config.class ?? ''}" style="color:${config.color};" ${tip_attrs(config.title, config.description)}></i>`;
}

// --- Parts --------------------------------------------------------------
const PartsStatus = {
	NewRequest: "New request",
	ReadyForPickup: "Ready for pickup",
	Delivered: "Delivered",
};
const PARTS_DEFAULT_STATUS = PartsStatus.Delivered;

const parts_duotone_svg = (color) => `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="15.75" viewBox="0 0 576 512"><path class="fa-secondary" opacity=".4" fill="${color}" d="M552 64H159.2l52.4 256h293.2a24 24 0 0 0 23.4-18.7l47.3-208a24 24 0 0 0 -18.1-28.7A23.7 23.7 0 0 0 552 64z"/><path class="fa-primary" fill="${color}" d="M218.1 352h268.4a24 24 0 0 1 23.4 29.3l-5.5 24.3a56 56 0 1 1 -63.6 10.4H231.2a56 56 0 1 1 -67.1-8.6L93.9 64H24A24 24 0 0 1 0 40V24A24 24 0 0 1 24 0h102.5A24 24 0 0 1 150 19.2z"/></svg>`;
const parts_flat_svg = (color) => `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="15.75" viewBox="0 0 576 512"><path fill="${color}" d="M528.1 301.3l47.3-208C578.8 78.3 567.4 64 552 64H159.2l-9.2-44.8C147.8 8 137.9 0 126.5 0H24C10.7 0 0 10.7 0 24v16c0 13.3 10.7 24 24 24h69.9l70.2 343.4C147.3 417.1 136 435.2 136 456c0 30.9 25.1 56 56 56s56-25.1 56-56c0-15.7-6.4-29.8-16.8-40h209.6C430.4 426.2 424 440.3 424 456c0 30.9 25.1 56 56 56s56-25.1 56-56c0-22.2-12.9-41.3-31.6-50.4l5.5-24.3c3.4-15-8-29.3-23.4-29.3H218.1l-6.5-32h293.1c11.2 0 20.9-7.8 23.4-18.7z"/></svg>`;

const PARTS_ICONS = {
	[PartsStatus.NewRequest]: {
		svg: parts_duotone_svg(IconColor.red),
		description: "Parts have been requested and are not here yet.",
	},
	[PartsStatus.ReadyForPickup]: {
		svg: parts_duotone_svg(IconColor.green),
		description: "The parts arrived and are ready to be picked up.",
	},
	[PartsStatus.Delivered]: {
		svg: parts_flat_svg(IconColor.gray),
		description: "The parts were delivered, or this project needs no parts.",
	},
};

export function render_parts_icon(status) {
	const state = PARTS_ICONS[status] ? status : PARTS_DEFAULT_STATUS;
	const title = `Parts: ${status || PARTS_DEFAULT_STATUS}`;
	return `<span ${tip_attrs(title, PARTS_ICONS[state].description)}>${PARTS_ICONS[state].svg}</span>`;
}

// --- Software -----------------------------------------------------------
const SoftwareStatus = {
	Request: "Software request",
	Ready: "Software is ready for use",
	Attached: "Software has been attached",
};
const SOFTWARE_DEFAULT_STATUS = SoftwareStatus.Attached;

const software_svg = (color) => `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity="1" fill="${color}" d="M24 190v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42V88H30a6 6 0 0 0 -6 6zm482 6h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0-96h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm0 192h-18v-6a6 6 0 0 0 -6-6h-42v48h42a6 6 0 0 0 6-6v-6h18a6 6 0 0 0 6-6v-12a6 6 0 0 0 -6-6zm-482-6v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6zm0-96v6H6a6 6 0 0 0 -6 6v12a6 6 0 0 0 6 6h18v6a6 6 0 0 0 6 6h42v-48H30a6 6 0 0 0 -6 6z"/><path class="fa-primary" fill="${color}" d="M144 512a48 48 0 0 1 -48-48V48a48 48 0 0 1 48-48h224a48 48 0 0 1 48 48v416a48 48 0 0 1 -48 48z"/></svg>`;

const SOFTWARE_ICONS = {
	[SoftwareStatus.Request]: {
		svg: software_svg(IconColor.red),
		description: "Software work has been requested but is not ready.",
	},
	[SoftwareStatus.Ready]: {
		svg: software_svg(IconColor.green),
		description: "The software is ready to be used.",
	},
	[SoftwareStatus.Attached]: {
		svg: software_svg(IconColor.gray),
		description: "The software has been attached, or this project needs no software.",
	},
};

export function render_software_icon(status) {
	const state = SOFTWARE_ICONS[status] ? status : SOFTWARE_DEFAULT_STATUS;
	const title = `Software: ${status || "No status"}`;
	return `<span ${tip_attrs(title, SOFTWARE_ICONS[state].description)}>${SOFTWARE_ICONS[state].svg}</span>`;
}

// --- Loan car -----------------------------------------------------------
const LoanCarStatus = {
	No: "No",
	CarReturned: "Car returned",
	Yes: "Yes",
	LoanedCar: "Loaned car",
};
const LOAN_CAR_DEFAULT_STATUS = LoanCarStatus.No;

const loan_car_svg = (color, opacity) => `<svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 512 512"><path class="fa-secondary" opacity="${opacity}" fill="${color}" d="M303.1 348.9l.1 .1-24 27a24 24 0 0 1 -17.9 8H224v40a24 24 0 0 1 -24 24h-40v40a24 24 0 0 1 -24 24H24a24 24 0 0 1 -24-24v-78a24 24 0 0 1 7-17l161.8-161.8-.1-.4a176.2 176.2 0 0 0 134.3 118.1z"/><path class="fa-primary" fill="${color}" d="M336 0a176 176 0 1 0 176 176A176 176 0 0 0 336 0zm48 176a48 48 0 1 1 48-48 48 48 0 0 1 -48 48z"/></svg>`;

// Each Loan Car status gets its own light colour so none look alike. "No" and
// "Car returned" both mean "no active loan car", so they stay in the neutral
// family but with different tints (gray vs blue-slate) instead of being identical.
// Yes = pending handover (warm/attention); Loaned car = active loan (green).
const LoanCarColor = {
	no: "#d9d9d9",          // No — neutral gray
	carReturned: "#b9c4cf", // Car returned — blue-slate (done, distinct from "No")
	yes: "#f0a0a0",         // Yes — light red (requested, not handed over yet)
	loanedCar: "#a3d9a5",   // Loaned car — light green (active)
};

const LOAN_CAR_ICONS = {
	[LoanCarStatus.No]: {
		svg: loan_car_svg(LoanCarColor.no, "0.8"),
		description: "No loan car is involved in this project.",
	},
	[LoanCarStatus.CarReturned]: {
		svg: loan_car_svg(LoanCarColor.carReturned, "0.8"),
		description: "The loan car has already been returned.",
	},
	[LoanCarStatus.Yes]: {
		svg: loan_car_svg(LoanCarColor.yes, ".4"),
		description: "A loan car was requested but has not been handed over yet.",
	},
	[LoanCarStatus.LoanedCar]: {
		svg: loan_car_svg(LoanCarColor.loanedCar, ".4"),
		description: "A loan car is currently handed over to the customer.",
	},
};

export function render_loan_car_icon(status) {
	const state = LOAN_CAR_ICONS[status] ? status : LOAN_CAR_DEFAULT_STATUS;
	const title = `Loan Car: ${status || LOAN_CAR_DEFAULT_STATUS}`;
	return `<span ${tip_attrs(title, LOAN_CAR_ICONS[state].description)}>${LOAN_CAR_ICONS[state].svg}</span>`;
}

// --- Pickup -------------------------------------------------------------
const PickupStatus = {
	Dropoff: "Dropoff service",
	DropoffArranged: "Dropoff service arranged",
	Pickup: "Pickup service",
	PickupArranged: "Pickup service arranged",
};
// Sentinel for "no pickup/dropoff service on this project".
const NO_PICKUP = "None";

// Dropoff and Pickup are different actions that share the same taxi icon, so with
// one shared colour they were indistinguishable. Each status now gets its own light
// colour while the family still carries meaning: warm = pending (to arrange),
// green/teal = arranged, gray = none. Dropoff vs Pickup differ within each family.
const PickupColor = {
	dropoff: "#f0a0a0",         // Dropoff pending — light red
	dropoffArranged: "#a3d9a5", // Dropoff arranged — light green
	pickup: "#f3b485",          // Pickup pending — light orange (distinct from dropoff)
	pickupArranged: "#83d1bb",  // Pickup arranged — teal (distinct from dropoff arranged)
	none: "#d9d9d9",            // No service — neutral gray
};

const PICKUP_ICONS = {
	[PickupStatus.Dropoff]: {
		color: PickupColor.dropoff,
		class: "blink-red",
		title: PickupStatus.Dropoff,
		description: "The car must be dropped off at the customer. Still to be arranged.",
	},
	[PickupStatus.DropoffArranged]: {
		color: PickupColor.dropoffArranged,
		title: PickupStatus.DropoffArranged,
		description: "The dropoff has been arranged.",
	},
	[PickupStatus.Pickup]: {
		color: PickupColor.pickup,
		class: "blink-red",
		title: PickupStatus.Pickup,
		description: "The car must be picked up from the customer. Still to be arranged.",
	},
	[PickupStatus.PickupArranged]: {
		color: PickupColor.pickupArranged,
		title: PickupStatus.PickupArranged,
		description: "The pickup has been arranged.",
	},
	[NO_PICKUP]: {
		color: PickupColor.none,
		title: "Pickup Status: None",
		description: "No pickup or dropoff service for this project.",
	},
};

export function render_pickup_icon(status) {
	const config = PICKUP_ICONS[status] || PICKUP_ICONS[NO_PICKUP];
	return `<i class="fa fa-taxi  ${config.class ?? ''}" style="color:${config.color};" ${tip_attrs(config.title, config.description)}></i>`;
}

// --- Lane ---------------------------------------------------------------
const LaneStatus = {
	Fast: "FAST",
	Heavy: "HEAVY",
};
const LANE_DEFAULT_STATUS = LaneStatus.Heavy;

const LANE_ICONS = {
	[LaneStatus.Fast]: {
		icon: "fa-tint",
		color: "#cdaa88",
		font_size: "1rem",
		title: "Fast Lane",
		description: "Quick job — handled in the fast lane.",
	},
	[LaneStatus.Heavy]: {
		icon: "fa-wrench",
		color: "#aab3c0",
		font_size: "1.1rem",
		title: "Heavy Lane",
		description: "Regular workshop job — handled in the heavy lane. Also the default when no lane is set.",
	},
};

export function render_lane_icon(lane) {
	const config = LANE_ICONS[lane] || LANE_ICONS[LANE_DEFAULT_STATUS];
	return `<i class="fa ${config.icon}" style="color: ${config.color}; font-size: ${config.font_size}; margin-left: 4px; vertical-align: middle;" ${tip_attrs(config.title, config.description)}></i>`;
}

// --- Whatsapp -----------------------------------------------------------
const WHATSAPP_ICON = {
	title: "Whatsapp Conversation",
	description: "This project has an unread Whatsapp conversation with the customer.",
};

export function render_whatsapp_icon() {
	return `<img src="/assets/frappe/icons/jobcard/square-whatsapp.svg" style="height:1.2rem;margin-top:2px;" ${tip_attrs(WHATSAPP_ICON.title, WHATSAPP_ICON.description)} />`;
}

// --- Icon legend --------------------------------------------------------
// Describes the icon families for the legend modal. Every row renders through the
// same `render_*_icon()` function the cards use and pulls its text from the same
// map, so the legend cannot drift from what the board actually paints.
const ICON_LEGEND = [
	{
		title: "Quotation",
		note: "Derived from the linked Quotation only. When a project has several quotations, the most advanced one is shown.",
		rows: () => Object.keys(QUOTATION_ICONS).map(status => ({
			icon: render_quotation_icon(status),
			label: status === NO_QUOTATION ? "No quotation" : status,
			description: QUOTATION_ICONS[status].description,
		})),
	},
	{
		title: "Parts",
		rows: () => Object.keys(PARTS_ICONS).map(status => ({
			icon: render_parts_icon(status),
			label: status,
			description: PARTS_ICONS[status].description,
		})),
	},
	{
		title: "Software",
		rows: () => Object.keys(SOFTWARE_ICONS).map(status => ({
			icon: render_software_icon(status),
			label: status,
			description: SOFTWARE_ICONS[status].description,
		})),
	},
	{
		title: "Loan Car",
		rows: () => Object.keys(LOAN_CAR_ICONS).map(status => ({
			icon: render_loan_car_icon(status),
			label: status,
			description: LOAN_CAR_ICONS[status].description,
		})),
	},
	{
		title: "Pickup",
		rows: () => Object.keys(PICKUP_ICONS).map(status => ({
			icon: render_pickup_icon(status),
			label: status === NO_PICKUP ? "No pickup service" : status,
			description: PICKUP_ICONS[status].description,
		})),
	},
	{
		title: "Lane",
		note: "Only shown on the workshop kanban.",
		rows: () => Object.keys(LANE_ICONS).map(lane => ({
			icon: render_lane_icon(lane),
			label: LANE_ICONS[lane].title,
			description: LANE_ICONS[lane].description,
		})),
	},
	{
		title: "Whatsapp",
		rows: () => [{
			icon: render_whatsapp_icon(),
			label: WHATSAPP_ICON.title,
			description: WHATSAPP_ICON.description,
		}],
	},
];

function build_icon_legend_html() {
	const sections = ICON_LEGEND.map(section => {
		const rows = section.rows().map(row => `
			<tr>
				<td style="width: 34px; text-align: center; vertical-align: middle;">${row.icon}</td>
				<td style="white-space: nowrap; vertical-align: middle; font-weight: 500;">${row.label}</td>
				<td style="vertical-align: middle; color: var(--text-muted, #8d99a6);">${row.description}</td>
			</tr>
		`).join("");
		return `
			<div style="margin-bottom: 18px;">
				<h5 style="margin-bottom: 2px;">${section.title}</h5>
				${section.note ? `<p style="font-size: 11px; color: var(--text-muted, #8d99a6); margin-bottom: 6px;">${section.note}</p>` : ""}
				<table class="table table-bordered" style="margin-bottom: 0; font-size: 12px;">
					<tbody>${rows}</tbody>
				</table>
			</div>
		`;
	}).join("");
	return `<div class="kanban-icon-legend">${sections}</div>`;
}

export function showIconLegendDialog() {
	const dialog = new frappe.ui.Dialog({
		title: "Icon Legend",
		size: "large",
		fields: [
			{
				fieldtype: "HTML",
				options: build_icon_legend_html(),
			},
		],
		primary_action_label: "Close",
		primary_action: function () {
			dialog.hide();
		},
	});

	dialog.show();
}
