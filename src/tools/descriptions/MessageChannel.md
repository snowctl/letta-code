# MessageChannel

Send a message or channel action to an external channel.

When you receive a `<channel-notification>`, use this tool to reply directly to the user on the same external channel. A normal assistant response is not delivered back to the external channel automatically.

There are two supported send modes:
- Reply mode: use `channel` + `chat_id` from the notification to respond in the current routed chat.
- Proactive mode: use `channel` + `target` on supported channels to send to an explicit outbound destination.

Preferred reply pattern:
- `action="send"` to send a normal reply
- `channel` + `chat_id` from the notification attributes
- `message` for the text body

Editing your own messages:
- `action="edit"` rewrites the body of a message *you* sent earlier — useful for status messages that update over time (e.g. "Working on X..." → "Done with X.") instead of cluttering the chat with a new message per state. Required: `chat_id`, `messageId` (the original send returned a `message_id` you can pass back here), and `message` (the new body).
- Edits aren't supported on every channel; the schema's action enum reflects what each currently-active channel supports. If `edit` isn't supported, prefer sending a new message rather than retrying.

Parameters:
- `action`: The action to perform. The exact available actions depend on the active channel plugins and are reflected in the JSON schema.
- `channel`: The platform to send to.
- `chat_id`: Reply target for the current routed chat. Use this when responding to a channel notification.
- `target`: Explicit outbound target for proactive sends on supported channels.
- `accountId`: Optional channel account selector when multiple eligible accounts are available.
- `message`: Text body. Required for `action="send"` (the new message text) and `action="edit"` (the replacement body for the existing message).
- `replyTo`: Optional message ID to reply to. Omit this unless you intentionally want the platform's quote/reply UI.
- `messageId`: Target message id. Required for `action="react"` (the message you're reacting to) and `action="edit"` (the message you're editing — must be one *you* sent).
- `emoji`: Optional reaction payload for channels that support reactions.
- `remove`: Optional boolean to remove a reaction instead of adding it.
- `media`: Optional absolute local file path for file/media uploads on channels that support uploads.
- `filename`: Optional uploaded filename override when supported by the channel.
- `title`: Optional uploaded attachment title when supported by the channel.

Rules:
- Always pass `action` explicitly, even for a normal reply.
- Pass exactly one of `chat_id` or `target`.
- `react` should be its own call.
- `upload-file` can include both `media` and `message` so the uploaded file has a caption/comment when the channel supports it.
- `edit` only works on messages you sent — you can't edit messages from the user or other agents.
