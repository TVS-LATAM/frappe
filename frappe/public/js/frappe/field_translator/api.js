class Api {
  constructor(aws_url) {
    this.aws_url = aws_url
  }

  async getPreSignedUrl(params) {
    return fetch(`${this.aws_url}/chat-integration/pre-signed-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    }).then((res) => res.json())
  }
  async uploadFile({ file, url }) {
    return fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type,
      },
      body: file,
    })
  }
  async transcribe(file_key, language) {
    return fetch(`${this.aws_url}/chat-integration/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_key,
        language,
      }),
    }).then((res) => res.json())
  }
  async deleteFile(file_key) {
    return fetch(`${this.aws_url}/chat-integration/delete-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_key,
      }),
    })
  }
  async translate(payload) {
    return fetch(`${this.aws_url}/project/translate-field`, {
      method: "POST",
		  body: JSON.stringify(payload)
    }).then(res => res.json())
  }
}

export { Api }
