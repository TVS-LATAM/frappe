// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// MIT License. See license.txt

if (frappe.require) {
  frappe.require("show_icons.bundle.js");
} else {
  frappe.ready(function () {
    frappe.require("show_icons.bundle.js");
  });
}
