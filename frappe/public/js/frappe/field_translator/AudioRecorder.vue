<template>
  <div class="audio-container">
    <button v-if="!recording && !file" @click="mountAudio"
      class="record-button"
      title="Start recording">
      <i class="fa fa-microphone"></i>
    </button>
    <div v-if="recording" class="recording-indicator">
      <span class="recording-dot"></span>
      <span class="time-display">{{ formatTime }}</span>
    </div>
    <button v-if="recording" @click="stop"
      class="control-button"
      title="Stop recording">
      <i class="fa fa-stop"></i>
    </button>
    <button v-if="recording" @click="restart"
      class="control-button"
      title="Restart recording">
      <i class="fa fa-repeat"></i>
    </button>
    <span v-if="onGoing" class="transcribing-indicator">
      <i class="fa fa-circle transcribing-dot"></i>
      Transcribing...
    </span>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed, onUnmounted } from "vue";
import { Api } from './api.js'
const props = defineProps({
  aws_url: {
    type: String,
    required: true,
  },
  return_transcription: {
    type: Function,
    required: true,
  },
})
const file = ref<File | null>(null)
const mediaRecorder = ref<MediaRecorder | null>(null)
let audioData: Blob[] = []
const timer = ref(0)
const mediaStream = ref<MediaStream | null>(null)
const transcription = ref<string>('')
const translation = ref<string>('')
const onGoing = ref<boolean>(false)
const recording = computed(() => mediaRecorder.value?.state === 'recording')
const current_file_key = ref<string>('')
const interval = ref()
const api = new Api(props.aws_url)
const startTimer = () => {
  interval.value = setInterval(() => {
    timer.value += 1
  }, 1000)
}

const formatTime = computed(() => {
  const minutes = Math.floor(timer.value / 60)
    .toString()
    .padStart(2, '0')
  const seconds = (timer.value % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
})

const stop = () => {
  mediaRecorder!.value.stop()
}

const transcribe = async () => {
  onGoing.value = true

  if (!file.value!.size) {
    transcription.value = 'No file selected'
    onGoing.value = false
    return
  }

  transcription.value = 'Uploading record...'

  const name = new Date().getTime()
  const file_key = `${name}.${file.value!.name.split('.').pop()}`
  const { url } = await api.getPreSignedUrl({
    key: file_key,
    contentType: file.value!.type,
    timestamp: new Date().toISOString(),
    send_file: false
  })

  await api.uploadFile({
    url,
    file: file.value!
  })

  const result = await api.transcribe(`uploaded/${file_key}`, 'nl')

  console.log({ transcription_result: result })

  if (!result.transcription) {
    transcription.value = 'Transcription failed'
    onGoing.value = false
    return
  }

  const timeout = setTimeout(() => {
    transcription.value = 'Transcribing...'
  }, 3000)

  clearTimeout(timeout)

  // transcription.value = result.transcription
  // translation.value = result.translation
  onGoing.value = false
  await deleteFile(file_key)
  props.return_transcription(result.translation)
}

const stopRecording = () => {
  if (!mediaRecorder.value) return
  clearInterval(interval.value)
  mediaRecorder.value!.stop()
  mediaStream.value!.getTracks().forEach((track) => track.stop())
  const blob = new Blob(audioData, { type: mediaRecorder.value!.mimeType })
  file.value = new File([blob], `audio.ogg`, { type: 'audio/ogg' })
  mediaRecorder.value = null
  transcribe()
}

const deleteFile = async (file_key: string) => {
  await api.deleteFile(file_key)
  current_file_key.value = ''
  audioData = []
  timer.value = 0
  file.value = null
}

const mountAudio = () => {
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    mediaStream.value = stream
    mediaRecorder.value = new MediaRecorder(stream)
    mediaRecorder.value.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) {
        audioData.push(e.data)
      }
    })
    mediaRecorder.value.start()
    mediaRecorder.value.addEventListener('stop', stopRecording)
    startTimer()
  })
}

const restart = async () => {
  await deleteFile(current_file_key.value)
  transcription.value = ''
  translation.value = ''
  mountAudio()
}


onMounted(() => {
  console.log("Field Translator Mounted")
})

onUnmounted(() => {
  if (mediaRecorder.value) {
    mediaStream.value!.getTracks().forEach((track) => track.stop())
    mediaRecorder.value!.stop()
    mediaRecorder.value = null
  }
})
</script>

<style scoped>
.audio-container {
  display: flex;
  gap: 1rem;
}

.record-button,
.control-button {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  border-radius: 0.25rem;
  background-color: white;
  border: 1px solid #d1d5db;
}

.record-button:hover,
.control-button:hover {
  background-color: #f9fafb;
}

.recording-indicator {
  display: inline-flex;
  align-items: center;
  font-size: 0.75rem;
}

.recording-dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background-color: #ef4444;
  margin-right: 0.25rem;
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.time-display {
  margin-right: 0.25rem;
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

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes ping {
  75%, 100% {
    transform: scale(2);
    opacity: 0;
  }
}
</style>