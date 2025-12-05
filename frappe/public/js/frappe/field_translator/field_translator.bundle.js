import { createApp } from "vue";  
import FieldTranslatorComponent from "./FieldTranslator.vue";

class FieldTranslator {
    constructor({
      docname, 
      field_container, 
      field_element, 
      field, 
      languages,
      chatbot_url,
      aws_url,
      quill
    }) {
      this.field = field
      this.docname = docname
      this.quill = quill
      this.field_container = field_container

      const app = createApp(FieldTranslatorComponent, { 
        languages, 
        update_field: this.update_field.bind(this),
        get_field_content: this.get_field_content.bind(this),
        print_translation: this.print_translation.bind(this),
        chatbot_url,
        aws_url,
        docname,
        field_name: field
      });
      SetVueGlobals(app);
      app.mount(field_element);
    }
    update_field(value){
			const range = this.quill.getSelection(true)
      let index = this.quill.getText().length
			if(!range){
        return
			}
      this.quill.insertText(range.index || index, value, 'api');
    }
    get_field_content(){
      return this.quill.getText()
    }
    print_translation(text){
      const translation = this.field_container.querySelector('#translation-container') || document.createElement('div')
      translation.id = 'translation-container'

      translation.style = 'background:#f3f3f3;padding:12px 15px;height:300px;overflow:scroll;font-size:13px;margin-bottom:1rem;'
      translation.innerHTML = text

      this.field_container.appendChild(translation)
    } 
}

frappe.provide("frappe.ui")
frappe.ui.FieldTranslator = FieldTranslator;
export default FieldTranslator