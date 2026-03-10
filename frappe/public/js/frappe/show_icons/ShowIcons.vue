<template>
  <button v-if="isVisible" id="show-icons" name="show-icons" :class="{ 'close-icon-container': isCloseIcon }"
    @click="toggleIcons">
    <ToolIcon :isCloseIcon="isCloseIcon" />
  </button>
</template>

<script setup>
import { ref, onMounted } from "vue";
import ToolIcon from "./ToolIcon.vue";

const isVisible = ref(true);
const isCloseIcon = ref(false);

const checkRoles = () => {
  if (window.frappe && window.frappe.boot) {
    if (
      window.frappe.boot.is_workshop_viewer ||
      window.frappe.boot.is_mechanic ||
      window.frappe.boot.is_junior_mechanic ||
      window.frappe.boot.is_senior_mechanic
    ) {
      isVisible.value = false;
    }
  }
};

const toggleIcons = () => {
  isCloseIcon.value = !isCloseIcon.value;

  const isCalibrator = window.frappe && window.frappe.boot && window.frappe.boot.is_calibrator;

  const chat = document.querySelector("erp-full-chat");
  const calendar = document.querySelector("erp-calendar");

  let chatIconContainer = null;
  let calendarIconContainer = null;

  if (chat && chat.shadowRoot) {
    chatIconContainer = chat.shadowRoot.querySelector("#full-chat-icon-container");
  }

  if (calendar && calendar.shadowRoot) {
    calendarIconContainer = calendar.shadowRoot.querySelector("#calendar-icon-container");
  }

  if (chatIconContainer) {
    chatIconContainer.classList.toggle("hidden");
  }

  if (calendarIconContainer) {
    calendarIconContainer.classList.toggle("hidden");
  }
};

onMounted(() => {
  checkRoles();
});
</script>

<style scoped>
#show-icons {
  position: fixed;
  bottom: 1.2rem;
  right: 9.5rem;
  width: 30px;
  height: 30px;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0px;
  background: white;
  z-index: 10;
}

#show-icons :deep(svg) {
  height: 1rem;
  width: 1rem;
  margin: 0 auto;
}

#show-icons.close-icon-container {
  right: 1rem !important;
  width: 30px;
  height: 30px;
  border: 1px solid rgb(31, 41, 55);
  bottom: 1rem;
}
</style>
