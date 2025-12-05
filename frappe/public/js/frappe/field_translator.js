// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// MIT License. See license.txt

if (frappe.require) {
	frappe.require("field_translator.bundle.js");
} else {
	frappe.ready(function () {
		frappe.require("field_translator.bundle.js");
	});
}
