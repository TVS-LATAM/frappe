<template>
  <button @click="add++">add</button>
  <button @click="printContent">print content</button>
  {{ add }}
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps({
  languages: {
    type: Array<string>,
    required: true
  },
  update_field: {
    type: Function,
    required: true
  },
  get_field_content: {
    type: Function,
    required: true
  }
})
const add = ref<number>(0)

watch(add, () => {
  props.update_field(add.value)
})

function printContent(){
  console.log('print content', props.get_field_content())
}
</script>
