// Bearer token for the tvs-cloud-services `/chat-integration/*` routes. ERPNext
// mints it for the logged-in user (whatsapp_chat.chat_token.get_chat_token, 15
// minutes) and the chat-bot Lambda authorizer verifies it. Same contract as
// erp-chat's src/chatToken.ts: refresh a minute early, and on a 401/403 mint a
// fresh one and retry once (a denying authorizer answers 403).
// Failure is soft: with no token the call goes out without the header and the
// Lambda side decides (report mode logs it, enforce mode refuses it).
const CHAT_TOKEN_METHOD = 'whatsapp_chat.chat_token.get_chat_token'
const REFRESH_MARGIN_MS = 60000

let cachedToken = null
let tokenInFlight = null

const mintChatToken = () =>
  new Promise((resolve) => {
    frappe.call({
      method: CHAT_TOKEN_METHOD,
      silent: true,
      callback: (r) => {
        const message = r && r.message
        if (message && typeof message.token === 'string' && message.token && typeof message.expires_at === 'number') {
          cachedToken = { token: message.token, expiresAt: message.expires_at }
          resolve(message.token)
        } else {
          resolve(null)
        }
      },
      error: () => resolve(null),
    })
  })

const getChatToken = () => {
  if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return Promise.resolve(cachedToken.token)
  }
  if (!tokenInFlight) {
    tokenInFlight = mintChatToken().finally(() => {
      tokenInFlight = null
    })
  }
  return tokenInFlight
}

const withChatAuth = async (init) => {
  const token = await getChatToken()
  if (!token) return init
  return { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }
}

// Only for our own `/chat-integration` routes. The S3 pre-signed PUT must stay
// header-free: S3 refuses a signed URL that also carries an Authorization header.
const chatFetch = async (url, init) => {
  let res = await fetch(url, await withChatAuth(init))
  if (res.status === 401 || res.status === 403) {
    cachedToken = null
    res = await fetch(url, await withChatAuth(init))
  }
  return res
}

class Api {
  constructor(aws_url) {
    this.aws_url = aws_url
  }

  async getPreSignedUrl(params) {
    return chatFetch(`${this.aws_url}/chat-integration/pre-signed-url`, {
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
    return chatFetch(`${this.aws_url}/chat-integration/transcribe`, {
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
    return chatFetch(`${this.aws_url}/chat-integration/delete-file`, {
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
