<template>
  <div class="translator-container">
    <div v-if="!loading" v-for="language in languages" :key="language" :class="`flag ${language}`" @click="translate(language)"></div>
    <AudioRecorder v-if="!loading" :aws_url="chatbot_url" :return_transcription="returnTranscription" />

    <span v-if="loading" class="transcribing-indicator">
      <i class="fa fa-circle transcribing-dot"></i>
      Translating...
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue"
import AudioRecorder from './AudioRecorder.vue'
import { Api } from './api'

const props = defineProps({
  languages: {
    type: Array<string>,
    required: true,
  },
  chatbot_url: {
    type: String,
    required: true,
  },
  aws_url: {
    type: String,
    required: true,
  },
  update_field: {
    type: Function,
    required: true,
  },
  get_field_content: {
    type: Function,
    required: true
  },
  print_translation: {
    type: Function,
    required: true
  },
  docname: {
    type: String,
    required: true
  },
  field_name: {
    type: String,
    required: true
  }
})

const loading = ref<boolean>(false)

const api = new Api(props.aws_url)

const returnTranscription = (transcription: string) => {
  props.update_field(transcription)
}

const translate = async (lang) => {
  loading.value = true
  const text = props.get_field_content()

  const payload = {
		project_name: props.docname,
		language: lang,
		content: text,
		field_name: props.field_name
	};

  const result = await api.translate(payload)

  loading.value = false

  props.print_translation(result.translation)
}
</script>

<style scoped>
.translator-container {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.transcribing-indicator {
  font-size: 0.75rem;
  color: #6b7280;
  display: inline-flex;
  align-items: center;
}

.transcribing-dot {
  color: #ef4444;
  margin-right: 0.25rem;
  animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
}

@keyframes ping {
  75%, 100% {
    transform: scale(2);
    opacity: 0;
  }
}
</style>