from math import log
import os
import re
from io import BytesIO

from frappe.contacts.doctype.address.address import get_address_display_list
from pypdf import PdfWriter

import frappe
from frappe import _
from frappe.core.doctype.access_log.access_log import make_access_log
from frappe.translate import print_language
from frappe.utils.deprecations import deprecated
from frappe.utils.pdf import get_pdf

no_cache = 1

base_template_path = "www/printview.html"
standard_format = "templates/print_formats/standard.html"

from frappe.www.printview import capitalize_first_letter, filter_customer, validate_print_permission


@frappe.whitelist()
def download_multi_pdf(
    doctype, name, format=None, no_letterhead=False, letterhead=None, options=None
):
    """
    Concatenate multiple docs as PDF .

    Returns a PDF compiled by concatenating multiple documents. The documents
    can be from a single DocType or multiple DocTypes

    Note: The design may seem a little weird, but it exists exists to
            ensure backward compatibility. The correct way to use this function is to
            pass a dict to doctype as described below

    NEW FUNCTIONALITY
    =================
    Parameters:
    doctype (dict):
            key (string): DocType name
            value (list): of strings of doc names which need to be concatenated and printed
    name (string):
            name of the pdf which is generated
    format:
            Print Format to be used

    Returns:
    PDF: A PDF generated by the concatenation of the mentioned input docs

    OLD FUNCTIONALITY - soon to be deprecated
    =========================================
    Parameters:
    doctype (string):
            name of the DocType to which the docs belong which need to be printed
    name (string or list):
            If string the name of the doc which needs to be printed
            If list the list of strings of doc names which needs to be printed
    format:
            Print Format to be used

    Returns:
    PDF: A PDF generated by the concatenation of the mentioned input docs
    """

    import json

    pdf_writer = PdfWriter()

    if isinstance(options, str):
        options = json.loads(options)

    if not isinstance(doctype, dict):
        result = json.loads(name)

        # Concatenating pdf files
        for i, ss in enumerate(result):
            pdf_writer = frappe.get_print(
                doctype,
                ss,
                format,
                as_pdf=True,
                output=pdf_writer,
                no_letterhead=no_letterhead,
                letterhead=letterhead,
                pdf_options=options,
            )
        frappe.local.response.filename = "{doctype}.pdf".format(
            doctype=doctype.replace(" ", "-").replace("/", "-")
        )
    else:
        for doctype_name in doctype:
            for doc_name in doctype[doctype_name]:
                try:
                    pdf_writer = frappe.get_print(
                        doctype_name,
                        doc_name,
                        format,
                        as_pdf=True,
                        output=pdf_writer,
                        no_letterhead=no_letterhead,
                        letterhead=letterhead,
                        pdf_options=options,
                    )
                except Exception:
                    frappe.log_error(
                        title="Error in Multi PDF download",
                        message=f"Permission Error on doc {doc_name} of doctype {doctype_name}",
                        reference_doctype=doctype_name,
                        reference_name=doc_name,
                    )
        frappe.local.response.filename = f"{name}.pdf"

    with BytesIO() as merged_pdf:
        pdf_writer.write(merged_pdf)
        frappe.local.response.filecontent = merged_pdf.getvalue()

    frappe.local.response.type = "pdf"


@deprecated
def read_multi_pdf(output: PdfWriter) -> bytes:
    with BytesIO() as merged_pdf:
        output.write(merged_pdf)
        return merged_pdf.getvalue()

 
    
def format_address_detail_to_print(text):
    if not text:
        return ""
    
    address = text.get('address_line1')
    address2 = text.get('address_line2')
    zip_code = text.get('pincode')
    city = text.get('city')
    country = text.get('country')
    
    address = address.strip() if address else None
    address2 = address2.strip() if address2 else None
    zip_code = zip_code.strip() if zip_code else None
    city = city.strip() if city else None
    country = country.strip() if country else None
    
    address_parts = []
    if address:
        address_parts.append(address)
    if address2:
        address_parts.append(address2)

    # Concatenar zip_code y city en una sola línea
    zip_city = ""
    if zip_code:
        zip_city += zip_code
    if city:
        if zip_code:
            zip_city += ", "  # Agregar coma solo si zip_code ya existe
        zip_city += city

    if zip_city:  # Solo agregar si no está vacío
        address_parts.append(zip_city)

    # Agregar el país en una línea aparte si existe
    if country:
        address_parts.append(country)

    # Unir las partes de la dirección con <br> para separar las líneas
    return "<br>".join(address_parts)


def convert_to_int(value):
    try:
        # Convert the value to a float first to handle both numeric strings and numbers
        float_value = float(value)
        # Convert the float value to an integer
        int_value = int(float_value)
        return int_value
    except ValueError:
        # If the value cannot be converted to a float, raise an error
        raise ValueError("The input value is not a number or a numeric string")

@frappe.whitelist(allow_guest=True)
def download_pdf(
    doctype, name, format=None, doc=None, no_letterhead=0, language=None, letterhead=None
):
    doc = doc or frappe.get_doc(doctype, name)
    
    original_customer_name  = ""
    if doc.get("customer_name"):
        original_customer_name = doc.get("original_customer_name")
        doc.original_customer_name = doc.get("customer_name")
        doc.customer_name = capitalize_first_letter(doc.get("customer_name"))
        
    if doc.get("doctype") in ["Quotation", "Sales Invoice"]:
        if(original_customer_name):
            customers = frappe.db.sql(
                    """
                    SELECT
                        name, customer_name
                    FROM
                        `tabCustomer` cust
                    WHERE
                        cust.customer_name = %(name_pattern)s
                    """,
                    {
                        "name_pattern": original_customer_name,
                    },
                    as_dict=1,
                )
            if len(customers):
                customer_filtered = filter_customer(customers, original_customer_name)
                
                if customer_filtered:
                    customer_filtered_name = customer_filtered.name
                    address_records = get_address_display_list("Customer", customer_filtered_name)
                    
                    if address_records and isinstance(address_records, list):
                        billing_address = next((address for address in address_records if address.get("address_type") == "Billing" and address.get("disabled") == 0), None)
                        shipping_address = next((address for address in address_records if address.get("address_type") == "Shipping" and address.get("disabled") == 0), None)
                        selected_address = billing_address or shipping_address or address_records[0]
                    else:
                        selected_address = None
                        
                    doc.address_display = format_address_detail_to_print(selected_address)
                else:
                    doc.address_display = ""


    items_custom = []
    if((doc.get("doctype") == "Quotation" or doc.get("doctype") == "Sales Invoice")):
        for item in doc.get("items"):
            if(doc.get("doctype") == "Sales Invoice"):
                value = frappe.get_doc("Sales Invoice Item", item.name)
            if(doc.get("doctype") == "Quotation"):
                value = frappe.get_doc("Quotation Item", item.name)
            items_custom.append({
                    "item_code": value.get("item_code"),
                    "item_name": value.get("item_name"),
                    "description": value.get("description"),
                    "brand": value.get("brand"),
                    "base_amount": "{:.2f}".format(value.get("base_amount", 0)),
                    "tvs_pn": value.get("tvs_pn") or "",
                    "qty": convert_to_int(value.get("qty")),
                    "rate": "{:.2f}".format(value.get("rate", 0)),
                    })
        doc.items_custom = items_custom
    
    doc.base_total = "{:.2f}".format(doc.get("base_total"))
    doc.base_total_taxes_and_charges = "{:.2f}".format(doc.get("base_total_taxes_and_charges"))
    doc.grand_total = "{:.2f}".format(doc.get("grand_total"))
    
    validate_print_permission(doc)

    with print_language(language):
        pdf_file = frappe.get_print(
            doctype,
            name,
            format,
            doc=doc,
            as_pdf=True,
            letterhead=letterhead,
            no_letterhead=no_letterhead,
        )

    frappe.local.response.filename = "{name}.pdf".format(
        name=name.replace(" ", "-").replace("/", "-")
    )
    frappe.local.response.filecontent = pdf_file
    frappe.local.response.type = "pdf"


@frappe.whitelist()
def report_to_pdf(html, orientation="Landscape"):
    make_access_log(file_type="PDF", method="PDF", page=html)
    frappe.local.response.filename = "report.pdf"
    frappe.local.response.filecontent = get_pdf(html, {"orientation": orientation})
    frappe.local.response.type = "pdf"


@frappe.whitelist()
def print_by_server(
    doctype, name, printer_setting, print_format=None, doc=None, no_letterhead=0, file_path=None
):
    print_settings = frappe.get_doc("Network Printer Settings", printer_setting)
    try:
        import cups
    except ImportError:
        frappe.throw(_("You need to install pycups to use this feature!"))

    try:
        cups.setServer(print_settings.server_ip)
        cups.setPort(print_settings.port)
        conn = cups.Connection()
        output = PdfWriter()
        output = frappe.get_print(
            doctype,
            name,
            print_format,
            doc=doc,
            no_letterhead=no_letterhead,
            as_pdf=True,
            output=output,
        )
        if not file_path:
            file_path = os.path.join("/", "tmp", f"frappe-pdf-{frappe.generate_hash()}.pdf")
        output.write(open(file_path, "wb"))
        conn.printFile(print_settings.printer_name, file_path, name, {})
    except OSError as e:
        if (
            "ContentNotFoundError" in e.message
            or "ContentOperationNotPermittedError" in e.message
            or "UnknownContentError" in e.message
            or "RemoteHostClosedError" in e.message
        ):
            frappe.throw(_("PDF generation failed"))
    except cups.IPPError:
        frappe.throw(_("Printing failed"))
