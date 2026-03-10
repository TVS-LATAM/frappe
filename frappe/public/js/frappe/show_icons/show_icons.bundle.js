import { createApp } from "vue";
import ShowIconsComponent from "./ShowIcons.vue";

// Wait for document ready to attach the global UI
console.log("show-icons-app");
const el = document.getElementById("show-icons-app");
if (el) {
  const app = createApp(ShowIconsComponent);
  SetVueGlobals(app);
  app.mount(el);
}
